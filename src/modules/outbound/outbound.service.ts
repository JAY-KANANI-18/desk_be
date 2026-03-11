// src/outbound/outbound.service.ts
//
// Send messages on any channel. Handles:
//   text, image, video, audio, document, sticker, location,
//   WhatsApp templates, email HTML, Messenger quick_replies

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from '../channels/channel-registry.service';
import { validateTemplateVariables, buildTemplateComponents } from '../channels/utils/template-validator';

// ─── DTO ─────────────────────────────────────────────────────────────────────

export interface OutboundAttachment {
    url: string;          // always our storage URL
    mimeType: string;
    filename?: string;
}

export interface OutboundDto {
    workspaceId: string;
    channelId: string;
    conversationId: string;

    to: string;           // phone / PSID / email
    text?: string;
    subject?: string;     // email
    htmlBody?: string;    // email HTML
    replyToMessageId?: string;
    attachments?: OutboundAttachment[];
        buttons?: Array<{ id?: string; title: string }>; // WhatsApp interactive buttons

    // WhatsApp approved template
    template?: {
        name: string;
        language: string;
        components?: any[];
    };

    // Messenger / Instagram quick replies
    quickReplies?: Array<{ title: string; payload: string }>;

    // Internal author (agent user ID)
    authorId?: string;
}



// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface SendAttachmentDto {
    type: string;       // image | video | audio | document | sticker
    url: string;        // our internal storage URL
    mimeType: string;
    filename?: string;
}

export interface SendMessageDto {
    workspaceId?: string;   // optional — derived from conversation if omitted
    conversationId: string;
    channelId: string;
    authorId?: string;

    text?: string;
    subject?: string;       // email

    attachments?: SendAttachmentDto[];
    replyToMessageId?: string;
    metadata?: {
        // WhatsApp template
        template?: {
            name: string;
            language: string;
            variables?: Record<string, string>;  // { "1": "John", "2": "Order #123" }
        };
        // Email HTML body
        htmlBody?: string;
        // Messenger quick replies
        quickReplies?: Array<{ title: string; payload: string }>;
        [key: string]: any;
    };
}
// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class OutboundService {
    private readonly logger = new Logger(OutboundService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ChannelRegistry,
        private readonly events: EventEmitter2,
    ) { }



    async sendMessage(params: SendMessageDto) {
        /* ── 1. Load conversation + contact ─────────────────────────────────── */

        const conversation = await this.prisma.conversation.findUnique({
            where: { id: params.conversationId },
            include: { contact: true },
        });

        if (!conversation) throw new NotFoundException('Conversation not found');

        const contact = conversation.contact;
        const workspaceId = params.workspaceId ?? conversation.workspaceId;

        /* ── 2. Load channel ────────────────────────────────────────────────── */

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
            where: {
                contactId: contact.id,
                channelId: channel.id,
            },
        });

        // Fallback chain — contactChannel is most reliable
        const to =
            contactChannel?.identifier ??
            contact.phone ??
            contact.email;

        if (!to) {
            throw new BadRequestException(
                `No reachable identifier found for contact ${contact.id} on channel ${channel.id}`,
            );
        }

        /* ── 4. Create Message record (pending) ─────────────────────────────── */

        const message = await this.prisma.message.create({
            data: {
                workspaceId,
                conversationId: conversation.id,
                channelId: channel.id,
                channelType: channel.type,
                type: params.metadata?.template ? 'template' : (params.attachments?.length ? params.attachments[0].type : 'text'),
                text: params.text,
                subject: params.subject,
                direction: 'outgoing',
                status: 'pending',
                authorId: params.authorId ?? null,
                metadata: params.metadata ?? null,
            },
        });

        try {
            /* ── 5a. WhatsApp Template ─────────────────────────────────────────── */

            if (params.metadata?.template) {
                const result = await this.sendTemplate({
                    channel,
                    provider,
                    conversation,
                    contact,
                    to,
                    templateMeta: params.metadata.template,
                    workspaceId,
                });

                await this.prisma.message.update({
                    where: { id: message.id },
                    data: { status: 'sent', channelMsgId: result?.id },
                });

                await this.updateConversationLastMessage(conversation.id, message.id);
                this.emitSent(workspaceId, channel.id, conversation.id, message.id, result?.id);
                return message;
            }

            /* ── 5b. Resolve attachments (upload media if provider requires it) ─── */

            const resolvedAttachments = await this.resolveAttachments(
                channel,
                provider,
                params.attachments ?? [],
            );

            /* ── 5c. Send regular message ─────────────────────────────────────── */

            const payload: OutboundDto =
            {
                channelId: channel.id,
                workspaceId,
                conversationId: conversation.id,
                to,
                text: params.text,
                subject: params.subject,
                htmlBody: params.metadata?.htmlBody,
                quickReplies: params.metadata?.quickReplies,
                attachments: resolvedAttachments,
            }
            const providerPayload = await this.buildPayload(channel.type, payload);


            //   const sendFn =  provider.sendMessage;
            this.logger.debug(`Sending message convId=${conversation.id} to ${to} via provider ${channel.type} with payload: ${JSON.stringify(params)}`);
            const result: any = await provider.sendMessage(channel, providerPayload);

            /* ── 6. Persist MessageAttachment rows ───────────────────────────── */

            if (resolvedAttachments.length > 0) {
                await this.prisma.messageAttachment.createMany({
                    data: resolvedAttachments.map((att) => ({
                        messageId: message.id,
                        type: att.type,
                        name: att.filename ?? null,
                        mimeType: att.mimeType,
                        url: att.url,
                    })),
                });
            }

            /* ── 7. Update message status ────────────────────────────────────── */

            await this.prisma.message.update({
                where: { id: message.id },
                data: { status: 'sent', channelMsgId: result?.id ?? null },
            });

            /* ── 8. Update conversation lastMessage ──────────────────────────── */

            await this.updateConversationLastMessage(conversation.id, message.id);

            this.emitSent(workspaceId, channel.id, conversation.id, message.id, result?.id);

            return message;

        } catch (err) {
            // Mark message as failed so the UI can show the error
            await this.prisma.message.update({
                where: { id: message.id },
                data: { status: 'failed', metadata: { ...(params.metadata ?? {}), error: err.message } },
            }).catch(() => { }); // swallow secondary error

            this.logger.error(`sendMessage failed convId=${conversation.id}: ${err.message}`, err.stack);
            throw err;
        }
    }

    // ─── Template send ────────────────────────────────────────────────────────

    private async sendTemplate(opts: {
        channel: any;
        provider: any;
        conversation: any;
        contact: any;
        to: string;
        templateMeta: { name: string; language: string; variables?: Record<string, string> };
        workspaceId: string;
    }) {
        const { channel, provider, conversation, to, templateMeta, workspaceId } = opts;

        const template = await this.prisma.whatsAppTemplate.findFirst({
            where: {
                workspaceId,
                channelId: channel.id,
                name: templateMeta.name,
                language: templateMeta.language,
                status: 'APPROVED',
            },
        });

        if (!template) {
            throw new BadRequestException(
                `Template "${templateMeta.name}" (${templateMeta.language}) not found or not approved`,
            );
        }

        // Validate all required variables are supplied
        validateTemplateVariables(template.components as any[], templateMeta.variables);

        // Build the components array with variables substituted
        const components = buildTemplateComponents(
            template.components as any[],
            templateMeta.variables,
        );

        const sendFn = provider.send ?? provider.sendMessage;
        return sendFn.call(provider, {
            channelId: channel.id,
            conversationId: conversation.id,
            to,
            template: {
                name: template.name,
                language: { code: template.language },
                components,
            },
        });
    }

    // ─── Attachment resolution ────────────────────────────────────────────────
    //
    // Some providers (WhatsApp) require you to upload media first and send
    // a media_id instead of a URL. Others (Messenger, email) accept URLs directly.

    private async resolveAttachments(
        channel: any,
        provider: any,
        attachments: SendAttachmentDto[],
    ): Promise<SendAttachmentDto[]> {
        if (!attachments.length) return [];

        const resolved: SendAttachmentDto[] = [];

        for (const att of attachments) {
            let url = att.url;

            // Provider signals it needs server-side upload (e.g. WhatsApp media upload API)
            if (provider.uploadMedia) {
                url = await provider.uploadMedia(channel, {
                    url: att.url,
                    mimeType: att.mimeType,
                    type: att.type,
                });
            }

            resolved.push({ ...att, url });
        }

        return resolved;
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private async updateConversationLastMessage(conversationId: string, messageId: string) {
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: {
                lastMessageId: messageId,
                lastMessageAt: new Date(),
            },
        });
    }

    private emitSent(
        workspaceId: string,
        channelId: string,
        conversationId: string,
        messageId: string,
        externalId?: string,
    ) {
        this.events.emit('message.outbound', {
            workspaceId,
            channelId,
            conversationId,
            messageId,
            externalId,
        });
    }

    // ─── Payload builders ────────────────────────────────────────────────────

    private buildPayload(channelType: string, dto: OutboundDto): any {
        switch (channelType) {
            case 'whatsapp': return this.buildWhatsApp(dto);
            case 'instagram': return this.buildMetaMessaging(dto);
            case 'messenger': return this.buildMetaMessaging(dto);
            case 'email': return this.buildEmailPayload(dto);
            default: throw new Error(`No payload builder for ${channelType}`);
        }
    }

    // ── WhatsApp ──────────────────────────────────────────────────────────────

   private buildWhatsApp(dto: OutboundDto): any {
    const base = {
        messaging_product: 'whatsapp',
        to: dto.to,
    };

    // Template message
    if (dto.template) {
        return {
            ...base,
            type: 'template',
            template: {
                name: dto.template.name,
                language: { code: dto.template.language },
                components: dto.template.components ?? [],
            },
        };
    }

    // Media message
    if (dto.attachments?.length) {
        const att = dto.attachments[0];
        const mediaType = this.waMediaType(att.mimeType);

        const payload: any = {
            ...base,
            type: mediaType,
            [mediaType]: {
                link: att.url,
            },
        };

        if (mediaType === 'document' && att.filename) {
            payload[mediaType].filename = att.filename;
        }

        if (dto.text && ['image', 'video', 'document'].includes(mediaType)) {
            payload[mediaType].caption = dto.text;
        }

        if (dto.replyToMessageId) {
            payload.context = {
                message_id: dto.replyToMessageId,
            };
        }

        return payload;
    }

    // Interactive buttons
    if (dto.buttons?.length) {
        return {
            ...base,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: dto.text ?? '' },
                action: {
                    buttons: dto.buttons.map((b, i) => ({
                        type: 'reply',
                        reply: {
                            id: b.id ?? `btn_${i}`,
                            title: b.title,
                        },
                    })),
                },
            },
        };
    }

    // Simple text message
    const payload: any = {
        ...base,
        type: 'text',
        text: {
            body: dto.text ?? '',
            preview_url: false,
        },
    };

    if (dto.replyToMessageId) {
        payload.context = {
            message_id: dto.replyToMessageId,
        };
    }

    return payload;
}

    private waMediaType(mimeType: string): string {
        if (mimeType === 'image/webp') return 'sticker';
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType.startsWith('audio/')) return 'audio';
        return 'document';
    }

    // ── Instagram / Messenger ─────────────────────────────────────────────────

    private buildMetaMessaging(dto: OutboundDto): any {
        const recipient = { id: dto.to };

        const message: any = {};


        // Text
        if (dto.text) {
            message.text = dto.text;
        }


        if (dto.attachments?.length) {
            const att = dto.attachments[0];

            const type =
                att.mimeType?.startsWith('image/') ? 'image' :
                    att.mimeType?.startsWith('video/') ? 'video' :
                        att.mimeType?.startsWith('audio/') ? 'audio' :
                            'file';

            message.attachment = {
                type,
                payload: {
                    url: att.url,
                    is_reusable: true,
                },
            };
        }
        if (dto.quickReplies?.length) {
            message.quick_replies = dto.quickReplies.map(qr => ({
                content_type: 'text',
                title: qr.title,
                payload: qr.payload,
            }));
        }

        // Reply to a specific message (thread reply)
        if (dto.replyToMessageId) {
            message.reply_to = {
                mid: dto.replyToMessageId,
            };
        }

        return { recipient, message };
    }

    // ── Email ─────────────────────────────────────────────────────────────────


    private async buildEmailPayload(
        dto: OutboundDto,
    ): Promise<any> {

        // If this is NOT a reply → send normal email
        if (!dto.replyToMessageId) {
            return {
                to: dto.to,
                subject: dto.subject ?? '(no subject)',
                text: dto.text,
                html: dto.htmlBody,
                attachments: dto.attachments ?? [],
            };
        }

        // Otherwise build reply payload
        const lastInbound: any = await this.prisma.message.findUnique({
            where: {
                id: dto.replyToMessageId,
            },
            include: {
                conversation: true,
                channel: true,
            },
        });

        if (!lastInbound) {
            throw new Error('Reply message not found');
        }

        const meta = lastInbound.metadata as any;

        const existingRefs: string = meta?.references ?? '';
        const replyingToId: string = meta?.messageId ?? '';

        const references = [existingRefs, replyingToId]
            .filter(Boolean)
            .join(' ')
            .trim();

        const subject = lastInbound.subject?.startsWith('Re:')
            ? lastInbound.subject
            : `Re: ${lastInbound.subject ?? '(no subject)'}`;

        return {
            from: lastInbound.channel.config?.emailAddress,
            to: dto.to,
            subject,
            text: dto.text,
            html: dto.htmlBody,
            attachments: dto.attachments ?? [],

            headers: {
                'In-Reply-To': replyingToId,
                'References': references,
            },
        };
    }
    // ─── DB ──────────────────────────────────────────────────────────────────

    private async persistMessage(dto: OutboundDto, channel: any, externalId: string) {
        const type = dto.template ? 'template'
            : dto.attachments?.length ? this.mimeToType(dto.attachments[0].mimeType)
                : 'text';

        return this.prisma.message.create({
            data: {
                workspaceId: dto.workspaceId,
                conversationId: dto.conversationId,
                channelId: dto.channelId,
                channelType: channel.type,
                type,
                direction: 'outgoing',
                text: dto.text,
                subject: dto.subject,
                channelMsgId: externalId,
                authorId: dto.authorId,
                status: 'sent',
                sentAt: new Date(),
                metadata: dto.template ? { template: dto.template } : undefined,
            },
        });
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
