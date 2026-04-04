// src/outbound/outbound.service.ts
// Wired with SendValidator (pre-send) + ProviderErrorNormaliser (post-error)

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { validateTemplateVariables, buildTemplateComponents } from '../channels/utils/template-validator';
import { SendValidator, ProviderErrorNormaliser } from './send-validator';
import { MediaService } from '../media/media.service';
import { ChannelAdaptersRegistry } from '../channel-adapters/channel-adapters.registry';

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



export interface ExternalOutboundDto {
    workspaceId: string;
    channelId: string;
    channelType: 'messenger' | 'instagram';  // only providers that echo

    /** Provider message ID (e.g. Meta mid) */
    channelMsgId: string;

    /**
     * The RECIPIENT's identifier — the customer's PSID / IG scoped ID.
     * For Messenger echo:  event.recipient.id
     * For Instagram echo:  event.recipient.id
     */
    recipientIdentifier: string;

    text?: string | null;
    attachments?: ExternalAttachment[];
    timestamp?: number;

    /** Optional — profile fetched from provider for contact creation */
    profile?: { name?: string; avatarUrl?: string } | null;

    metadata?: Record<string, any>;
}

export interface ExternalAttachment {
    type: string;        // 'image' | 'video' | 'audio' | 'file' | 'sticker'
    url?: string;        // direct URL (if available)
    payload?: { url?: string; sticker_id?: number };
    mimeType?: string;
}

// ─── Place this method inside OutboundService ─────────────────────────────────
// It needs access to: this.prisma, this.media, this.events, this.logger
// Make sure MediaService is injected: add it to constructor + OutboundModule


@Injectable()
export class OutboundService {
    private readonly logger = new Logger(OutboundService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly registry: ChannelAdaptersRegistry,
        private readonly events: EventEmitter2,
        private readonly media: MediaService,
    ) { }

    async sendMessage(params: SendMessageDto) {
        this.logger.debug('Initiating sendMessage with params', { params });
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
        console.log({ channel, conversation });

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
        this.logger.debug("Resolved contactChannel", { contactChannel });

        /* ── 4. PRE-SEND VALIDATION ──────────────────────────────────────────────
         *
         * Validates BEFORE creating any DB record so no orphan pending messages
         * are created when validation fails.
        ──────────────────────────────────────────────────────────────────────── */


        // webchat has no phone/PSID/email — sessionId is the identifier, no window restrictions
        if (channel.type !== 'webchat') {
            SendValidator.validateContact({
                channelType: channel.type,
                channelStatus: channel.status,
                credentials: channel.config as any,
                contactChannel,
                contactPhone: contact.phone,
                contactEmail: contact.email,
            });
        }

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

        let message = await this.prisma.message.create({
            data: {
                workspaceId,
                conversationId: conversation.id,
                channelId: channel.id,
                channelType: channel.type,
                type: messageType,
                text: params.text,
                subject: emailThreadMeta?.subject ?? params.subject,
                direction: 'outgoing',
                status: 'pending',
                authorId: params.authorId ?? null,
                metadata: {
                    contactIdentifier: contactChannel?.identifier ?? null,
                    ...(params.metadata ?? {}),
                    ...(emailThreadMeta ?? {}),
                },
            },
            include: {
                channel: true,
                author:true
            }
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
                channelId: channel.id,
                workspaceId,
                conversationId: conversation.id,
                to,
                text: params.text,
                subject: emailThreadMeta?.subject ?? params.subject,
                htmlBody: params.metadata?.htmlBody,
                quickReplies: params.metadata?.quickReplies,
                attachments: resolvedAttachments,
                replyToMessageId: params.replyToMessageId,
                emailHeaders: emailThreadMeta?.headers ?? null,
            });

            /* ── 7d. Send ────────────────────────────────────────────────────────── */

            const result: any = await provider.sendMessage(channel, providerPayload);
            console.log({ result });
            this.events.emit('message.outbound', {
                workspaceId, channelId: channel.id,
                conversationId: conversation.id,
                message: message
            });

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
                        type: att.type ?? this.mimeToType(att.mimeType),
                        name: att.filename ?? null,
                        mimeType: att.mimeType,
                        url: att.url,
                    })),
                });
            }


            /* ── 10. Mark sent ───────────────────────────────────────────────────── */

            message = await this.prisma.message.update({
                where: { id: message.id },
                data: { status: 'sent', channelMsgId: result?.externalId ?? result?.id ?? null, metadata: updatedMeta },
                include: { channel: true ,author:true }
            });

            await this.prisma.conversation.update({
                where: { id: conversation.id },
                data: { lastMessageId: message.id, lastMessageAt: new Date() },
            });

            this.events.emit('message.status_updated', {
                workspaceId: message.workspaceId,
                conversationId: message.conversationId,
                messageId: message.id,
                status: message.status,
            });

            return message;

        } catch (err) {

            // Mark the pending message as failed
            const msg: any = await this.prisma.message.update({
                where: { id: message.id },
                data: { status: 'failed', metadata: { ...(params.metadata ?? {}), error: err.message } },
            }).catch(() => { });
            this.events.emit('message.status_updated', {
                workspaceId: msg.workspaceId,
                conversationId: msg.conversationId,
                messageId: msg.id,
                status: msg.status,
            });
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
        console.log({ templateMeta });

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
            case 'whatsapp': return this.buildWhatsApp(dto);
            case 'instagram': return this.buildMetaMessaging(dto);
            case 'messenger': return this.buildMetaMessaging(dto);
            case 'email': return this.buildEmailPayload(dto);
            case 'webchat': return this.buildWebchatPayload(dto);  // ← add

            default: throw new Error(`No payload builder for ${channelType}`);
        }
    }
    // Add this method alongside your other builders:
    private buildWebchatPayload(dto: any): any {
        return {
            to: dto.to,           // sessionId
            text: dto.text ?? null,
            attachments: dto.attachments ?? [],
            sessionId: dto.to,           // same as identifier for webchat
        };
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
        await this.prisma.message.update({ where: { id: messageId }, data: { status: 'sent', channelMsgId: externalId ?? null }, include: { channel: true } });
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

    async processWhatsappStatusUpdate(params: {
        channelId: string;
        channelType: string;
        externalId: string;
        status: 'delivered' | 'read' | 'failed';
    }): Promise<void> {
        const { channelId, externalId, status } = params;

        // 1. Find message
        const message: any = await this.prisma.message.findFirst({
            where: { channelId, channelMsgId: externalId },
        });

        if (!message) {
            this.logger.warn(
                `Status update received for unknown message. channelId=${channelId} externalId=${externalId} status=${status}`,
            );
            return;
        }

        // 2. Update message status
        await this.prisma.message.update({
            where: { id: message.id },
            data: { status, metadata: { ...message.metadata, status } },
        });



        // 4. Emit event
        this.events.emit('message.status_updated', {
            workspaceId: message.workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            status,
        });
    }
    async processMessengerDelivery(params: {
        channelId: string;
        externalId: string;
    }): Promise<void> {

        const { channelId, externalId } = params;

        const message: any = await this.prisma.message.findFirst({
            where: { channelId, channelMsgId: externalId },
        });

        if (!message) {
            this.logger.warn(
                `Messenger delivery for unknown message. channelId=${channelId} externalId=${externalId}`
            );
            return;
        }

        await this.prisma.message.update({
            where: { id: message.id },
            data: {
                status: 'delivered',
                metadata: { ...message.metadata, status: 'delivered' },
            },
        });

        this.events.emit('message.status_updated', {
            workspaceId: message.workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            status: 'delivered',
        });
    }
    async processMessengerRead(params: {
        channelId: string;
        contactIdentifier: string;
        watermark: number;
    }): Promise<void> {

        const { channelId, contactIdentifier, watermark } = params;

        const messages = await this.prisma.message.findMany({
            where: {
                channelId,
                direction: 'outgoing',

                sentAt: {
                    lte: new Date(watermark),
                },
                status: {
                    not: 'read',
                },
            },
            select: {
                id: true,
                workspaceId: true,
                conversationId: true,
                metadata: true,
            },
        });

        if (!messages.length) return;

        await this.prisma.message.updateMany({
            where: {
                id: { in: messages.map((m) => m.id) },
            },
            data: {
                status: 'read',
            },
        });

        for (const message of messages) {
            this.events.emit('message.status_updated', {
                workspaceId: message.workspaceId,
                conversationId: message.conversationId,
                messageId: message.id,
                status: 'read',
            });
        }
    }

    async processExternalOutbound(dto: ExternalOutboundDto): Promise<void> {
        const {
            workspaceId, channelId, channelType,
            channelMsgId, recipientIdentifier,
            text, attachments = [], timestamp,
            profile, metadata,
        } = dto;

        // ── 1. Dedup ───────────────────────────────────────────────────────────
        // If our system already created this message (sendMessage saved channelMsgId),
        // the echo arrives and we skip it cleanly.

        const existing = await this.prisma.message.findFirst({
            where: { channelMsgId, channelId },
            select: { id: true },
        });

        if (existing) {

            let m = await this.prisma.message.update({
                where: { id: existing.id },
                data: {
                    sentAt: timestamp ? new Date(timestamp) : new Date(),
                    metadata: { ...metadata, echoUpdatedAt: new Date() },
                },
            });
            console.log({ m });

            this.logger.debug(
                `ExternalOutbound: already stored channelMsgId=${channelMsgId} —${timestamp} Updating echo timestamp`,
            );
            return;
        }

        // ── 2. Upsert Contact + ContactChannel ────────────────────────────────
        // Same logic as InboundService.upsertContact() but we use recipientIdentifier.
        // The "contact" here is the customer the agent was talking to.

        const { contact } = await this.upsertContactForExternal({
            workspaceId,
            channelId,
            channelType,
            identifier: recipientIdentifier,
            profile,
        });

        // ── 3. Upsert Conversation ─────────────────────────────────────────────
        // Find open conversation for this contact on this channel, or create one.

        const conversation = await this.upsertConversationForExternal({
            workspaceId,
            channelId,
            channelType,
            contactId: contact.id,
        });

        // ── 4. Download attachments → R2 ──────────────────────────────────────
        // Meta CDN URLs expire ~1 hour after the webhook fires.
        // We normalise to ParsedAttachment shape so MediaService.processAttachments()
        // can handle them identically to inbound media.

        const parsedAttachments = attachments.map(att => ({
            type: att.type,
            url: att.payload?.url ?? att.url ?? '',
            mimeType: att.mimeType ?? this.guessMime(att.type),
            filename: null,
        }));

        const storedMedia = parsedAttachments.length > 0
            ? await this.media.processAttachments(channelId, workspaceId, parsedAttachments as any)
            : [];

        // ── 5. Create Message row ──────────────────────────────────────────────

        const messageType = text
            ? 'text'
            : (attachments[0]?.type ?? 'text');

        const message = await this.prisma.message.create({
            data: {
                workspaceId,
                conversationId: conversation.id,
                channelId,
                channelType,
                channelMsgId,
                type: messageType,
                direction: 'outgoing',
                text: text ?? null,
                status: 'sent',
                authorId: null,             // sent outside system — no known agent
                sentAt: timestamp ? new Date(timestamp) : new Date(),
                metadata: {
                    source: 'external',      // FE can render "sent via Meta app"
                    ...(metadata ?? {}),
                },
            },
            include: {
                channel: true
            }
        });

        // ── 6. Persist attachments ─────────────────────────────────────────────

        if (parsedAttachments.length > 0) {
            await this.prisma.messageAttachment.createMany({
                data: parsedAttachments.map((att, i) => ({
                    messageId: message.id,
                    type: att.type,
                    name: storedMedia[i]?.filename ?? null,
                    mimeType: storedMedia[i]?.mimeType ?? att.mimeType ?? null,
                    size: storedMedia[i]?.size ?? null,
                    url: storedMedia[i]?.url || att.url || '',
                    assetId: storedMedia[i]?.assetId ?? null,
                })),
            });
        }

        // ── 7. Update conversation lastMessage ────────────────────────────────

        await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: {
                lastMessageId: message.id,
                lastMessageAt: new Date(),
                // NOTE: do NOT increment unreadCount — this is an outgoing message
            },
        });

        // ── 8. Emit for WebSocket gateway ─────────────────────────────────────

        this.events.emit('message.outbound', {
            workspaceId,
            conversationId: conversation.id,
            message,
        });

        this.logger.log(
            `ExternalOutbound stored conv=${conversation.id} msg=${message.id} ` +
            `type=${messageType} channel=${channelType} attachments=${parsedAttachments.length}`,
        );
    }

    // ─── Private helpers (add alongside processExternalOutbound) ──────────────────

    private async upsertContactForExternal(opts: {
        workspaceId: string;
        channelId: string;
        channelType: string;
        identifier: string;
        profile?: { name?: string; avatarUrl?: string } | null;
    }) {
        const { workspaceId, channelId, channelType, identifier, profile } = opts;

        // Check if ContactChannel already exists
        const existing = await this.prisma.contactChannel.findFirst({
            where: { channelId, identifier },
            include: { contact: true },
        });

        if (existing) {
            // Update avatar/name if we now have profile data and didn't before
            if (profile?.name && !existing.displayName) {
                await this.prisma.contactChannel.update({
                    where: { id: existing.id },
                    data: { displayName: profile.name, avatarUrl: profile.avatarUrl ?? undefined },
                });
            }
            if (profile?.avatarUrl && !existing.contact.avatarUrl) {
                await this.prisma.contact.update({
                    where: { id: existing.contact.id },
                    data: { avatarUrl: profile.avatarUrl },
                });
            }
            return { contact: existing.contact, contactChannel: existing };
        }

        // Derive name from profile or identifier
        const nameParts = this.deriveNameExternal(identifier, channelType, profile);

        const contact = await this.prisma.contact.create({
            data: {
                workspaceId,
                firstName: nameParts.firstName,
                lastName: nameParts.lastName,
                avatarUrl: profile?.avatarUrl,
                // No phone/email for Messenger/Instagram — identifier is a PSID/IG ID
            },
        });

        const contactChannel = await this.prisma.contactChannel.create({
            data: {
                workspaceId,
                contactId: contact.id,
                channelId,
                channelType,
                identifier,
                displayName: profile?.name ?? null,
                avatarUrl: profile?.avatarUrl ?? null,
            },
            include: { contact: true },
        });

        return { contact, contactChannel };
    }

    private async upsertConversationForExternal(opts: {
        workspaceId: string;
        channelId: string;
        channelType: string;
        contactId: string;
    }) {
        const { workspaceId, channelId, channelType, contactId } = opts;

        const existing = await this.prisma.conversation.findFirst({
            where: {
                workspaceId,
                contactId,
                status: { not: 'closed' },
            },
            orderBy: { updatedAt: 'desc' },
        });

        if (existing) {
            return this.prisma.conversation.update({
                where: { id: existing.id },
                data: { updatedAt: new Date() },
            });
        }

        return this.prisma.conversation.create({
            data: {
                workspaceId,

                contactId,
                status: 'open',
                priority: 'normal',
            },
        });
    }

    private deriveNameExternal(
        identifier: string,
        channelType: string,
        profile?: { name?: string } | null,
    ): { firstName: string; lastName?: string } {
        if (profile?.name) {
            const parts = profile.name.trim().split(' ');
            return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined };
        }
        // PSID / IG scoped ID — not human-readable, use channel type as fallback
        return { firstName: channelType === 'instagram' ? 'Instagram User' : 'Messenger User' };
    }

    private guessMime(type: string): string {
        switch (type) {
            case 'image': return 'image/jpeg';
            case 'video': return 'video/mp4';
            case 'audio': return 'audio/mpeg';
            case 'sticker': return 'image/webp';
            default: return 'application/octet-stream';
        }
    }


}