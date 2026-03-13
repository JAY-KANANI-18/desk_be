// src/outbound/outbound.service.ts
// Wired with SendValidator (pre-send) + ProviderErrorNormaliser (post-error)

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../channels/channel-registry.service';
import { validateTemplateVariables, buildTemplateComponents } from '../channels/utils/template-validator';
import { SendValidator, ProviderErrorNormaliser } from './send-validator';

export interface SendAttachmentDto {
  type: string;
  url: string;
  mimeType: string;
  filename?: string;
}

export interface SendMessageDto {
  workspaceId?: string;
  conversationId: string;
  channelId: string;
  authorId?: string;
  text?: string;
  subject?: string;
  attachments?: SendAttachmentDto[];
  replyToMessageId?: string;
  metadata?: {
    template?: { name: string; language: string; variables?: Record<string, string> };
    htmlBody?: string;
    quickReplies?: Array<{ title: string; payload: string }>;
    [key: string]: any;
  };
}

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelRegistry,
    private readonly events: EventEmitter2,
  ) {}

  async sendMessage(params: SendMessageDto) {

    /* ── 1. Load conversation + contact ──────────────────────────────────── */

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: params.conversationId },
      include: { contact: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');

    const contact = conversation.contact;
    const workspaceId = params.workspaceId ?? conversation.workspaceId;

    /* ── 2. Load channel ─────────────────────────────────────────────────── */

    const channel = await this.prisma.channel.findUnique({
      where: { id: params.channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const provider = this.registry.getProviderByType(channel.type);
    if (!provider.sendMessage) {
      throw new BadRequestException(`Provider ${channel.type} does not support sending`);
    }

        /* ── 3. Resolve the correct `to` address from ContactChannel ────────────
         *
         * IMPORTANT: Never use contact.phone / contact.email directly for channels
         * like Instagram or Messenger — the `to` must be the provider-scoped
         * identifier (PSID, IG scoped user ID), which lives in ContactChannel.
         *
         * For WhatsApp: ContactChannel.identifier = phone number (e.g. +1234567890)
         * For Instagram: ContactChannel.identifier = IG-scoped user ID
         * For Messenger: ContactChannel.identifier = PSID
         * For Email:     ContactChannel.identifier = email address
        ──────────────────────────────────────────────────────────────────────── */

    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { contactId: contact.id, channelId: channel.id },
    });

    /* ── 4. PRE-SEND VALIDATION ──────────────────────────────────────────────
     *
     * Validates BEFORE creating any DB record so no orphan pending messages
     * are created when validation fails.
    ──────────────────────────────────────────────────────────────────────── */

    SendValidator.validateContact({
      channelType:   channel.type,
      channelStatus: channel.status,
      credentials:   channel.config as any,
      contactChannel,
      contactPhone:  contact.phone,
      contactEmail:  contact.email,
    });

    // Safe to resolve `to` now — validation guarantees one of these exists
    const to = contactChannel?.identifier ?? contact.phone ?? contact.email!;

    /* ── 5. Email threading metadata ─────────────────────────────────────── */

    let emailThreadMeta: Record<string, any> | null = null;
    if (channel.type === 'email') {
      emailThreadMeta = await this.buildEmailThreadMeta(
        params.replyToMessageId,
        conversation,
        channel,
      );
    }

    /* ── 6. Create Message record (pending) ─────────────────────────────── */

    const messageType = params.metadata?.template
      ? 'template'
      : params.attachments?.length ? params.attachments[0].type : 'text';

    const message = await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        channelId:      channel.id,
        channelType:    channel.type,
        type:           messageType,
        text:           params.text,
        subject:        emailThreadMeta?.subject ?? params.subject,
        direction:      'outgoing',
        status:         'pending',
        authorId:       params.authorId ?? null,
        metadata: {
          ...(params.metadata ?? {}),
          ...(emailThreadMeta ?? {}),
        },
      },
    });

    try {

      /* ── 7a. WhatsApp template ───────────────────────────────────────────── */

      if (params.metadata?.template) {
        const result = await this.sendTemplate({
          channel, provider, conversation, to,
          templateMeta: params.metadata.template,
          workspaceId,
        });
        await this.finalise(message.id, result?.id, conversation.id, workspaceId, channel.id);
        return message;
      }

      /* ── 7b. Resolve attachments ─────────────────────────────────────────── */

      const resolvedAttachments = await this.resolveAttachments(
        channel, provider, params.attachments ?? [],
      );

      /* ── 7c. Build provider payload ─────────────────────────────────────── */

      const providerPayload = await this.buildPayload(channel.type, {
        channelId:     channel.id,
        workspaceId,
        conversationId: conversation.id,
        to,
        text:           params.text,
        subject:        emailThreadMeta?.subject ?? params.subject,
        htmlBody:       params.metadata?.htmlBody,
        quickReplies:   params.metadata?.quickReplies,
        attachments:    resolvedAttachments,
        replyToMessageId: params.replyToMessageId,
        emailHeaders:   emailThreadMeta?.headers ?? null,
      });

      /* ── 7d. Send ────────────────────────────────────────────────────────── */

      const result: any = await provider.sendMessage(channel, providerPayload);

      /* ── 8. Update metadata with real provider message ID ────────────────── */

      const updatedMeta = {
        ...(message.metadata as any ?? {}),
        ...(channel.type === 'email' && result?.id ? { messageId: result.id } : {}),
      };

      /* ── 9. Persist attachments ──────────────────────────────────────────── */

      if (resolvedAttachments.length > 0) {
        await this.prisma.messageAttachment.createMany({
          data: resolvedAttachments.map((att) => ({
            messageId: message.id,
            type:      att.type ?? this.mimeToType(att.mimeType),
            name:      att.filename ?? null,
            mimeType:  att.mimeType,
            url:       att.url,
          })),
        });
      }

      /* ── 10. Mark sent ───────────────────────────────────────────────────── */

      await this.prisma.message.update({
        where: { id: message.id },
        data:  { status: 'sent', channelMsgId: result?.id ?? null, metadata: updatedMeta },
      });

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data:  { lastMessageId: message.id, lastMessageAt: new Date() },
      });

      this.events.emit('message.outbound', {
        workspaceId, channelId: channel.id,
        conversationId: conversation.id,
        messageId: message.id, externalId: result?.id,
      });

      return message;

    } catch (err) {
      // Mark the pending message as failed
      await this.prisma.message.update({
        where: { id: message.id },
        data:  { status: 'failed', metadata: { ...(params.metadata ?? {}), error: err.message } },
      }).catch(() => {});

      // Normalise provider errors → structured SendError → BadRequestException
      ProviderErrorNormaliser.normalise(err, channel.type);
    }
  }

  // ─── Template ──────────────────────────────────────────────────────────────

private async sendTemplate(opts: {
  channel: any;
  provider: any;
  conversation: any;
  to: string;
  templateMeta: any;
  workspaceId: string;
}) {

  const { channel, provider, conversation, to, templateMeta, workspaceId } = opts;

  const template = await this.prisma.whatsAppTemplate.findFirst({
    where: {
      workspaceId,
      channelId: channel.id,
      name: templateMeta.name,
      language: templateMeta.language,
      status: "APPROVED",
    },
  });

  if (!template) {
    throw new BadRequestException(
      `Template "${templateMeta.name}" (${templateMeta.language}) not found or not approved`
    );
  }

  const variables = templateMeta.variables || [];

  validateTemplateVariables(template.components as any[], variables);

  let components: any[] | undefined;

  if (variables.length > 0) {
    components = [
      {
        type: "body",
        parameters: variables.map((v: string) => ({
          type: "text",
          text: v,
        })),
      },
    ];
  }

  const payload: any = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
    },
  };

  if (components) {
    payload.template.components = components;
  }

  return provider.sendMessage(channel, payload);
}

  // ─── Attachment resolution ─────────────────────────────────────────────────

  private async resolveAttachments(channel: any, provider: any, attachments: SendAttachmentDto[]): Promise<SendAttachmentDto[]> {
    if (!attachments.length) return [];
    const resolved: SendAttachmentDto[] = [];
    for (const att of attachments) {
      let url = att.url;
      if (provider.uploadMedia) url = await provider.uploadMedia(channel, { url: att.url, mimeType: att.mimeType, type: att.type });
      resolved.push({ ...att, url });
    }
    return resolved;
  }
  // ─── Email threading ───────────────────────────────────────────────────────

  private async buildEmailThreadMeta(
    replyToMessageId: string | undefined,
    conversation: any,
    channel: any,
  ): Promise<Record<string, any>> {
    const targetMessage = replyToMessageId
      ? await this.prisma.message.findUnique({ where: { id: replyToMessageId } })
      : await this.prisma.message.findFirst({
          where: { conversationId: conversation.id, direction: 'incoming', channelType: 'email' },
          orderBy: { createdAt: 'desc' },
        });

    if (!targetMessage) {
      return { subject: conversation.subject ?? '(no subject)', headers: null, messageId: null };
    }

    if (targetMessage.conversationId !== conversation.id) {
      throw new BadRequestException('replyToMessageId does not belong to this conversation');
    }

    const meta = targetMessage.metadata as any ?? {};
    const inReplyTo: string = meta.messageId ?? '';
    const existingRefs: string = meta.references ?? '';
    const references = [existingRefs, inReplyTo].filter(Boolean).join(' ').trim();
    const rawSubject = targetMessage.subject ?? conversation.subject ?? '(no subject)';
    const subject = rawSubject.startsWith('Re:') ? rawSubject : `Re: ${rawSubject}`;

    return {
      subject,
      headers: { 'In-Reply-To': inReplyTo, 'References': references },
      messageId: null,
      inReplyTo,
      references,
    };
  }

  // ─── Payload builders ──────────────────────────────────────────────────────

  private async buildPayload(channelType: string, dto: any): Promise<any> {
    switch (channelType) {
      case 'whatsapp':  return this.buildWhatsApp(dto);
      case 'instagram': return this.buildMetaMessaging(dto);
      case 'messenger': return this.buildMetaMessaging(dto);
      case 'email':     return this.buildEmailPayload(dto);
      default: throw new Error(`No payload builder for ${channelType}`);
    }
  }

  private buildWhatsApp(dto: any): any {
    const base = { messaging_product: 'whatsapp', to: dto.to };

    if (dto.template) {
      return { ...base, type: 'template', template: { name: dto.template.name, language: { code: dto.template.language }, components: dto.template.components ?? [] } };
    }
    if (dto.attachments?.length) {
      const att = dto.attachments[0];
      const mediaType = this.waMediaType(att.mimeType);
      const payload: any = { ...base, type: mediaType, [mediaType]: { link: att.url } };
      if (mediaType === 'document' && att.filename) payload[mediaType].filename = att.filename;
      if (dto.text && ['image', 'video', 'document'].includes(mediaType)) payload[mediaType].caption = dto.text;
      if (dto.replyToMessageId) payload.context = { message_id: dto.replyToMessageId };
      return payload;
    }
    if (dto.buttons?.length) {
      return { ...base, type: 'interactive', interactive: { type: 'button', body: { text: dto.text ?? '' }, action: { buttons: dto.buttons.map((b: any, i: number) => ({ type: 'reply', reply: { id: b.id ?? `btn_${i}`, title: b.title } })) } } };
    }
    const payload: any = { ...base, type: 'text', text: { body: dto.text ?? '', preview_url: false } };
    if (dto.replyToMessageId) payload.context = { message_id: dto.replyToMessageId };
    return payload;
  }

  private buildMetaMessaging(dto: any): any {
    const recipient = { id: dto.to };
    const message: any = {};
    if (dto.text) message.text = dto.text;
    if (dto.attachments?.length) {
      const att = dto.attachments[0];
      const type = att.mimeType?.startsWith('image/') ? 'image' : att.mimeType?.startsWith('video/') ? 'video' : att.mimeType?.startsWith('audio/') ? 'audio' : 'file';
      message.attachment = { type, payload: { url: att.url, is_reusable: true } };
    }
    if (dto.quickReplies?.length) {
      message.quick_replies = dto.quickReplies.map((qr: any) => ({ content_type: 'text', title: qr.title, payload: qr.payload }));
    }
    if (dto.replyToMessageId) message.reply_to = { mid: dto.replyToMessageId };
    return { recipient, message };
  }

  private buildEmailPayload(dto: any): any {
    return { to: dto.to, subject: dto.subject ?? '(no subject)', text: dto.text, html: dto.htmlBody, attachments: dto.attachments ?? [], headers: dto.emailHeaders ?? {} };
  }


  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async finalise(messageId: string, externalId: string | undefined, conversationId: string, workspaceId: string, channelId: string) {
    await this.prisma.message.update({ where: { id: messageId }, data: { status: 'sent', channelMsgId: externalId ?? null } });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageId: messageId, lastMessageAt: new Date() } });
    this.events.emit('message.outbound', { workspaceId, channelId, conversationId, messageId, externalId });
  }

  private waMediaType(mimeType: string): string {
    if (mimeType === 'image/webp') return 'sticker';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private mimeToType(mimeType: string): string {
    if (!mimeType) return 'document';
    if (mimeType === 'image/webp') return 'sticker';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }
}