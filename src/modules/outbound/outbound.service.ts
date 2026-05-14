// src/outbound/outbound.service.ts
// Wired with SendValidator (pre-send) + ProviderErrorNormaliser (post-error)

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { validateTemplateVariables, buildTemplateComponents } from '../channels/utils/template-validator';
import { SendValidator, ProviderErrorNormaliser } from './send-validator';
import { MediaService } from '../media/media.service';
import { ChannelAdaptersRegistry } from '../channel-adapters/channel-adapters.registry';
import {
    MESSENGER_TEMPLATE_CATALOG,
    MessengerTemplateCatalogItem,
} from '../channels/providers/meta/messenger/messenger-templates.service';
import {
    isMissingOrStaticContactAvatarUrl,
    resolveContactAvatarUrl,
} from '../../common/contacts/static-contact-avatar';
import { normalizeContactIdentifierForChannel } from '../../common/utils/contact-identifier.util';

export interface SendAttachmentDto {
    type: string;
    url: string;
    mimeType: string;
    filename?: string;
}

type QuickReplyOption = {
    title: string;
    payload: string;
};

type OutboundPayloadInput = {
    channelId?: string;
    workspaceId?: string;
    conversationId?: string;
    to: string;
    text?: string | null;
    subject?: string | null;
    htmlBody?: string | null;
    quickReplies?: unknown;
    quickReplyTextPrepared?: boolean;
    attachments?: SendAttachmentDto[];
    replyToMessageId?: string | null;
    emailHeaders?: Record<string, string> | null;
    template?: Record<string, any>;
    buttons?: Array<{ id?: string; title?: string }>;
    country?: string;
    from?: string | null;
    record?: boolean;
};

const META_QUICK_REPLY_LIMIT = 13;
const WHATSAPP_BUTTON_LIMIT = 3;
const WHATSAPP_LIST_LIMIT = 10;
const WHATSAPP_BUTTON_TITLE_LIMIT = 20;
const WHATSAPP_LIST_ROW_TITLE_LIMIT = 24;
const WHATSAPP_INTERACTIVE_ID_LIMIT = 256;
const TEXT_QUICK_REPLY_FALLBACK_CHANNELS = new Set(['email', 'sms', 'webchat']);

export interface SendMessageDto {
    workspaceId?: string;
    conversationId: string;
    channelId: string;
    authorId?: string;
    text?: string;
    subject?: string;
    attachments?: SendAttachmentDto[];
    replyToMessageId?: string;
    /** Links outbound rows to a broadcast batch for delivery analytics */
    broadcastRunId?: string;
    /** Links to the per-recipient broadcast ledger row for idempotency/reconciliation */
    broadcastRecipientId?: string;
    /** Stable queue/provider idempotency key, usually broadcastRunId:contactChannelId */
    idempotencyKey?: string;
    /** BullMQ attempt info, used to move exhausted jobs into dead_letter */
    queueAttempt?: number;
    queueMaxRetries?: number;
    metadata?: {
        template?: {
            id?: string;
            metaId?: string;
            name: string;
            language: string;
            variables?: Record<string, string> | string[];
            components?: any[];
            [key: string]: any;
        };
        htmlBody?: string;
        quickReplies?: QuickReplyOption[];
        emailUnsubscribe?: {
            token?: string;
            url: string;
        };
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

type BroadcastRecipientClaim =
    | { skip: true; message?: any }
    | { skip: false };

const BROADCAST_RECIPIENT_TERMINAL_STATUSES = new Set([
    'sent',
    'delivered',
    'read',
    'bounced',
    'unsubscribed',
    'dead_letter',
]);

const BROADCAST_RECIPIENT_STATUS_RANK: Record<string, number> = {
    pending: 0,
    queued: 1,
    sending: 2,
    sent: 3,
    delivered: 4,
    read: 5,
    failed: 6,
    bounced: 6,
    unsubscribed: 6,
    dead_letter: 6,
};

const BROADCAST_SENDING_LOCK_STALE_MS = 5 * 60 * 1000;

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
        this.logger.debug(`Initiating sendMessage channel=${params.channelId} conversation=${params.conversationId}`);
        /* ── 1. Load conversation + contact ──────────────────────────────────── */

        const conversation = await this.prisma.conversation.findUnique({
            where: { id: params.conversationId },
            include: { contact: true },
        });
        if (!conversation) throw new NotFoundException('Conversation not found');

        const contact = conversation.contact;
        const workspaceId = params.workspaceId ?? conversation.workspaceId;
        if (params.workspaceId && conversation.workspaceId !== params.workspaceId) {
            throw new BadRequestException('Conversation does not belong to this workspace');
        }
        const [author, latestMessage] = await Promise.all([
            params.authorId
                ? this.prisma.user.findUnique({
                    where: { id: params.authorId },
                    select: { firstName: true, lastName: true },
                })
                : Promise.resolve(null),
            this.prisma.message.findFirst({
                where: { conversationId: conversation.id },
                orderBy: { createdAt: 'desc' },
                select: { text: true },
            }),
        ]);
        const templateContext = this.buildTemplateContext(contact, author, latestMessage?.text ?? null);
        const renderedText = this.renderVariables(params.text, templateContext, 'message text');
        const renderedSubject = this.renderVariables(params.subject, templateContext, 'message subject');
        const renderedHtmlBody = this.renderVariables(params.metadata?.htmlBody, templateContext, 'email html');
        const replyTarget = params.replyToMessageId
            ? await this.resolveReplyTarget(params.replyToMessageId, conversation.id)
            : null;

        /* ── 2. Load channel ─────────────────────────────────────────────────── */

        const channel = await this.prisma.channel.findUnique({
            where: { id: params.channelId },
        });

        if (!channel) throw new NotFoundException('Channel not found');
        if (channel.workspaceId !== workspaceId) {
            throw new BadRequestException('Channel does not belong to this workspace');
        }

        const broadcastClaim = await this.claimBroadcastRecipient(params, workspaceId);
        if (broadcastClaim.skip) {
            return broadcastClaim.message;
        }

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

        
        let contactChannel = await this.prisma.contactChannel.findFirst({
            where: { contactId: contact.id, channelId: channel.id },
        });
        contactChannel = await this.ensureSendableContactChannel({
            workspaceId,
            channel,
            contact,
            contactChannel,
        });
        this.logger.debug("Resolved contactChannel", { contactChannel });

        /* ── 4. PRE-SEND VALIDATION ──────────────────────────────────────────────
         *
         * Validates BEFORE creating any DB record so no orphan pending messages
         * are created when validation fails.
        ──────────────────────────────────────────────────────────────────────── */


        // webchat has no phone/PSID/email — sessionId is the identifier, no window restrictions
        try {
            if (channel.type !== 'webchat') {
                SendValidator.validateContact({
                    channelType: channel.type,
                    channelStatus: channel.status,
                    credentials: channel.config as any,
                    contactChannel,
                    contactPhone: contact.phone,
                    contactEmail: contact.email,
                    hasTemplate: !!params.metadata?.template,
                });
            }
        } catch (err: any) {
            await this.failBroadcastRecipientForSend(params, workspaceId, err);
            throw err;
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
        const providerReplyToId = channel.type === 'email'
            ? undefined
            : replyTarget?.channelMsgId ?? undefined;
        const quotedMessage = this.buildQuotedMessagePreview(replyTarget);
        const quickReplies = this.normaliseQuickReplies(params.metadata?.quickReplies);
        let outboundText = this.applyQuickReplyTextFallback(channel.type, renderedText, quickReplies);
        let outboundHtmlBody = channel.type === 'email'
            ? this.appendQuickRepliesToHtml(renderedHtmlBody, quickReplies)
            : renderedHtmlBody;
        let emailHeaders = emailThreadMeta?.headers ?? null;
        const emailUnsubscribe = this.normaliseEmailUnsubscribe(params.metadata?.emailUnsubscribe);
        if (channel.type === 'email' && emailUnsubscribe) {
            outboundText = this.appendUnsubscribeText(outboundText, emailUnsubscribe.url);
            outboundHtmlBody = this.appendUnsubscribeHtml(outboundHtmlBody, emailUnsubscribe.url);
            emailHeaders = {
                ...(emailHeaders ?? {}),
                'List-Unsubscribe': `<${emailUnsubscribe.url}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            };
        }
        const outboundMetadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
        delete outboundMetadata.quickReplies;
        delete outboundMetadata.htmlBody;

        /* ── 6. Create Message record (pending) ─────────────────────────────── */

        const messageType = params.metadata?.template
            ? 'template'
            : params.attachments?.length ? params.attachments[0].type : 'text';

        const messageData = {
            workspaceId,
            conversationId: conversation.id,
            channelId: channel.id,
            channelType: channel.type,
            type: messageType,
            text: outboundText,
            subject: emailThreadMeta?.subject ?? renderedSubject,
            direction: 'outgoing',
            status: 'pending',
            authorId: params.authorId ?? null,
            broadcastRunId: params.broadcastRunId ?? null,
            broadcastRecipientId: params.broadcastRecipientId ?? null,
            replyToChannelMsgId: providerReplyToId ?? null,
            channelMsgId: null,
            sentAt: null,
            metadata: {
                contactIdentifier: contactChannel?.identifier ?? null,
                ...outboundMetadata,
                ...(quickReplies.length > 0 ? { quickReplies } : {}),
                ...(quotedMessage ? { quotedMessage } : {}),
                ...(outboundHtmlBody ? { htmlBody: outboundHtmlBody } : {}),
                ...(emailThreadMeta ? { ...emailThreadMeta, headers: emailHeaders } : {}),
            },
        };

        const existingBroadcastMessage = params.broadcastRecipientId
            ? await this.prisma.message.findFirst({
                where: { broadcastRecipientId: params.broadcastRecipientId },
                include: { channel: true, author: true },
            })
            : null;

        let message = existingBroadcastMessage
            ? await this.prisma.message.update({
                where: { id: existingBroadcastMessage.id },
                data: messageData,
                include: { channel: true, author: true },
            })
            : await this.prisma.message.create({
                data: messageData,
                include: { channel: true, author: true },
            });

        try {

            /* ── 7a. WhatsApp template ───────────────────────────────────────────── */

            if (params.metadata?.template) {
                const result = await this.sendTemplate({
                    channel, provider, conversation, to,
                    author,
                    templateMeta: params.metadata.template,
                    workspaceId,
                });
                const sentMessage = await this.finalise(
                    message.id,
                    result?.externalId ?? result?.id,
                    conversation.id,
                    workspaceId,
                    channel.id,
                    {
                        renderedText: outboundText ?? null,
                        renderedSubject: emailThreadMeta?.subject ?? renderedSubject ?? null,
                    },
                );
                await this.updateContactChannelWindowForOutbound({
                    contactChannelId: contactChannel?.id,
                    channelType: channel.type,
                    eventTimestamp: Date.now(),
                    metadata: params.metadata,
                });
                return sentMessage;
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
                text: outboundText,
                subject: emailThreadMeta?.subject ?? renderedSubject,
                htmlBody: outboundHtmlBody,
                quickReplies,
                quickReplyTextPrepared: true,
                attachments: resolvedAttachments,
                replyToMessageId: providerReplyToId,
                emailHeaders,
            });

            /* ── 7d. Send ────────────────────────────────────────────────────────── */

            const result: any = await provider.sendMessage(channel, providerPayload);
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
                data: {
                    status: 'sent',
                    channelMsgId: result?.externalId ?? result?.id ?? null,
                    sentAt: new Date(),
                    metadata: updatedMeta,
                },
                include: { channel: true ,author:true }
            });

            await this.reconcileBroadcastRecipientFromMessage(message, 'sent', {
                providerMessageId: result?.externalId ?? result?.id ?? null,
                renderedText: outboundText ?? null,
                renderedSubject: emailThreadMeta?.subject ?? renderedSubject ?? null,
            });

            await this.prisma.conversation.update({
                where: { id: conversation.id },
                data: { lastMessageId: message.id, lastMessageAt: new Date() },
            });

            await this.updateContactChannelWindowForOutbound({
                contactChannelId: contactChannel?.id,
                channelType: channel.type,
                eventTimestamp: Date.now(),
                metadata: updatedMeta,
            });

            this.events.emit('message.status_updated', {
                workspaceId: message.workspaceId,
                conversationId: message.conversationId,
                messageId: message.id,
                status: message.status,
            });

            return message;

        } catch (err: any) {
            const sendError = ProviderErrorNormaliser.toSendError(err, channel.type);

            // Mark the pending message as failed
            const msg: any = await this.prisma.message.update({
                where: { id: message.id },
                data: {
                    status: 'failed',
                    metadata: {
                        ...((message.metadata as Record<string, any>) ?? {}),
                        error: sendError.message,
                    },
                },
            }).catch(() => null);
            await this.failBroadcastRecipientForSend(params, workspaceId, sendError, message.id);
            if (msg) {
                this.events.emit('message.status_updated', {
                    workspaceId: msg.workspaceId,
                    conversationId: msg.conversationId,
                    messageId: msg.id,
                    status: msg.status,
                });
            }
            // Normalise provider errors → structured SendError → BadRequestException
            ProviderErrorNormaliser.normalise(err, channel.type);
        }
    }

    // ─── Template ──────────────────────────────────────────────────────────────

    async processQueueEntry(queueEntryId: string, attempt = 1, maxRetries = 1) {
        const queueEntry = await this.prisma.outboundQueue.findUnique({
            where: { id: queueEntryId },
            include: {
                channel: true,
                message: {
                    include: {
                        conversation: {
                            include: { contact: true },
                        },
                        author: {
                            select: { firstName: true, lastName: true },
                        },
                        messageAttachments: true,
                    },
                },
            },
        });

        if (!queueEntry?.message || !queueEntry.channel) {
            this.logger.warn(`Outbound queue entry not found: ${queueEntryId}`);
            return;
        }

        if (queueEntry.status === 'sent') {
            return;
        }

        await this.prisma.outboundQueue.update({
            where: { id: queueEntryId },
            data: {
                status: 'sending',
                attempts: attempt,
                maxRetries,
                lastError: null,
            },
        });

        const { channel, message } = queueEntry;
        const provider = this.registry.getProviderByType(channel.type);
        if (!provider.sendMessage) {
            throw new BadRequestException(`Provider ${channel.type} does not support sending`);
        }

        const payload = { ...(queueEntry.payload as Record<string, any>) };
        if (!payload.text && message.text) payload.text = message.text;
        if (!payload.subject && message.subject) payload.subject = message.subject;
        if (!payload.html && (message.metadata as any)?.htmlBody) {
            payload.html = (message.metadata as any).htmlBody;
        }
        if (!payload.attachments && message.messageAttachments.length > 0) {
            payload.attachments = message.messageAttachments.map((attachment) => ({
                type: attachment.type,
                url: attachment.url,
                mimeType: attachment.mimeType,
                filename: attachment.name,
            }));
        }

        try {
            const templateMeta = (message.metadata as Record<string, any> | null)?.template;
            const templateRecipient = queueEntry.to ?? payload.to ?? payload.recipient?.id ?? templateMeta?.to;
            if (templateMeta && !templateRecipient) {
                throw new BadRequestException('Missing template recipient');
            }
            const result: any = templateMeta
                ? await this.sendTemplate({
                    channel,
                    provider,
                    conversation: message.conversation,
                    author: message.author,
                    to: templateRecipient,
                    templateMeta,
                    workspaceId: message.workspaceId,
                })
                : await provider.sendMessage(channel, payload);
            const metadata = {
                ...((message.metadata as Record<string, any>) ?? {}),
                ...(channel.type === 'email' && result?.id ? { messageId: result.id } : {}),
            };

            await this.prisma.$transaction([
                this.prisma.message.update({
                    where: { id: message.id },
                    data: {
                        status: 'sent',
                        channelMsgId: result?.externalId ?? result?.id ?? null,
                        sentAt: new Date(),
                        metadata,
                    },
                }),
                this.prisma.outboundQueue.update({
                    where: { id: queueEntryId },
                    data: {
                        status: 'sent',
                        sentAt: new Date(),
                        lastError: null,
                    },
                }),
                this.prisma.conversation.update({
                    where: { id: message.conversationId },
                    data: {
                        lastMessageId: message.id,
                        lastMessageAt: new Date(),
                    },
                }),
            ]);

            await this.reconcileBroadcastRecipientFromMessage(
                {
                    ...message,
                    channelMsgId: result?.externalId ?? result?.id ?? null,
                },
                'sent',
                {
                    providerMessageId: result?.externalId ?? result?.id ?? null,
                    renderedText: message.text ?? null,
                    renderedSubject: message.subject ?? null,
                },
            );

            const contactChannel = await this.prisma.contactChannel.findFirst({
                where: {
                    contactId: message.conversation.contactId,
                    channelId: channel.id,
                },
                select: { id: true },
            });

            await this.updateContactChannelWindowForOutbound({
                contactChannelId: contactChannel?.id,
                channelType: channel.type,
                eventTimestamp: Date.now(),
                metadata,
            });

            this.events.emit('message.outbound', {
                workspaceId: message.workspaceId,
                conversationId: message.conversationId,
                message: {
                    ...message,
                    status: 'sent',
                    channelMsgId: result?.externalId ?? result?.id ?? null,
                    metadata,
                },
            });
            this.events.emit('message.status_updated', {
                workspaceId: message.workspaceId,
                conversationId: message.conversationId,
                messageId: message.id,
                status: 'sent',
            });
        } catch (err: any) {
            const sendError = ProviderErrorNormaliser.toSendError(err, channel.type);
            await this.prisma.outboundQueue.update({
                where: { id: queueEntryId },
                data: {
                    status: 'failed',
                    lastError: sendError.message,
                },
            });
            await this.prisma.message.update({
                where: { id: message.id },
                data: {
                    status: 'failed',
                    metadata: {
                        ...((message.metadata as Record<string, any>) ?? {}),
                        error: sendError.message,
                    },
                },
            });
            await this.reconcileBroadcastRecipientFromMessage(
                message,
                attempt >= maxRetries ? 'dead_letter' : 'failed',
                {
                    lastError: sendError.message,
                    attempts: attempt,
                    maxRetries,
                },
            );
            this.events.emit('message.status_updated', {
                workspaceId: message.workspaceId,
                conversationId: message.conversationId,
                messageId: message.id,
                status: 'failed',
            });
            throw err;
        }
    }

    private async sendTemplate(opts: {
        channel: any;
        provider: any;
        conversation: any;
        author: { firstName?: string | null; lastName?: string | null } | null;
        to: string;
        templateMeta: any;
        workspaceId: string;
    }) {

        const { channel, provider, to, workspaceId } = opts;
        const templateContext = this.buildTemplateContext(
            opts.conversation?.contact ?? {},
            opts.author,
            null,
        );
        const templateMeta = {
            ...opts.templateMeta,
            variables: this.renderTemplateVariables(
                opts.templateMeta?.variables,
                templateContext,
                'template variable',
            ),
        };

        if (channel.type === 'messenger') {
            return this.sendMessengerTemplate({
                channel,
                provider,
                to,
                templateMeta,
                workspaceId,
            });
        }

        if (channel.type !== 'whatsapp') {
            throw new BadRequestException(`Templates are not supported for ${channel.type}`);
        }

        const snapshotComponents = Array.isArray(templateMeta.components)
            ? templateMeta.components
            : null;
        const template = snapshotComponents
            ? {
                name: templateMeta.name,
                language: templateMeta.language,
                components: snapshotComponents,
            }
            : await this.prisma.whatsAppTemplate.findFirst({
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

        const variables = this.normaliseTemplateVariables(templateMeta.variables);

        const templateComponents = template.components as any[];
        validateTemplateVariables(templateComponents, variables);

        const components = buildTemplateComponents(templateComponents, variables);

        const payload: any = {
            messaging_product: "whatsapp",
            to,
            type: "template",
            template: {
                name: template.name,
                language: { code: template.language },
            },
        };

        if (components.length > 0) {
            payload.template.components = components;
        }

        return provider.sendMessage(channel, payload);
    }

    private async sendMessengerTemplate(opts: {
        channel: any;
        provider: any;
        to: string;
        templateMeta: any;
        workspaceId: string;
    }) {
        const { channel, provider, to, templateMeta, workspaceId } = opts;
        const templateId = templateMeta.metaId ?? templateMeta.id ?? templateMeta.name;
        const templateLookup: any[] = [
            { metaId: templateId },
            { name: templateId },
        ];

        if (this.isUuid(templateId)) {
            templateLookup.unshift({ id: templateId });
        }

        const row = await this.prisma.metaPageTemplate.findFirst({
            where: {
                workspaceId,
                channelId: channel.id,
                channelType: 'messenger',
                type: 'messenger_template',
                OR: templateLookup,
            },
        });

        const template =
            (row?.payload as unknown as MessengerTemplateCatalogItem | undefined) ??
            MESSENGER_TEMPLATE_CATALOG.find((item) =>
                item.metaId === templateId || item.name === templateId,
            );

        if (!template) {
            throw new BadRequestException(
                `Messenger template "${templateId}" not found`,
            );
        }

        const message = this.normaliseMessengerTemplateMessage(
            this.renderTemplateValue(
                template.payload,
                this.normaliseTemplateVariables(templateMeta.variables),
            ),
            template,
        );

        return provider.sendMessage(channel, {
            recipient: { id: to },
            message,
        });
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

    private async buildPayload(channelType: string, dto: OutboundPayloadInput): Promise<any> {
        const quickReplies = this.normaliseQuickReplies(dto.quickReplies);
        const preparedDto: OutboundPayloadInput = {
            ...dto,
            quickReplies,
            text: dto.quickReplyTextPrepared
                ? dto.text
                : this.applyQuickReplyTextFallback(channelType, dto.text, quickReplies),
            htmlBody: channelType === 'email' && !dto.quickReplyTextPrepared
                ? this.appendQuickRepliesToHtml(dto.htmlBody, quickReplies)
                : dto.htmlBody,
            quickReplyTextPrepared: true,
        };
        dto = preparedDto;

        switch (channelType) {
            case 'whatsapp': return this.buildWhatsApp(preparedDto);
            case 'instagram': return this.buildMetaMessaging(preparedDto);
            case 'messenger': return this.buildMetaMessaging(preparedDto);
            case 'email': return this.buildEmailPayload(preparedDto);
            case 'webchat': return this.buildWebchatPayload(dto);  // ← add
            case 'sms': return this.buildSmsPayload(preparedDto);
            case 'exotel_call': return this.buildExotelCallPayload(preparedDto);

            default: throw new Error(`No payload builder for ${channelType}`);
        }
    }
    // Add this method alongside your other builders:
    private buildWebchatPayload(dto: OutboundPayloadInput): any {
        const quickReplies = this.normaliseQuickReplies(dto.quickReplies);
        return {
            to: dto.to,           // sessionId
            text: dto.text ?? null,
            attachments: dto.attachments ?? [],
            quickReplies,
            sessionId: dto.to,           // same as identifier for webchat
        };
    }
    private buildWhatsApp(dto: OutboundPayloadInput): any {
        const base = { messaging_product: 'whatsapp', to: dto.to };
        const allQuickReplies = this.normaliseQuickReplies(dto.quickReplies);
        const quickReplies = allQuickReplies.slice(0, WHATSAPP_LIST_LIMIT);

        if (dto.template) {
            const language = typeof dto.template.language === 'string'
                ? dto.template.language
                : dto.template.language?.code;
            const rawComponents = Array.isArray(dto.template.components) ? dto.template.components : [];
            const sendReadyComponents = rawComponents.filter((component: any) =>
                Array.isArray(component?.parameters) || component?.sub_type,
            );
            const definitionComponents = rawComponents.filter((component: any) =>
                !Array.isArray(component?.parameters) && !component?.sub_type,
            );
            const components = [
                ...sendReadyComponents,
                ...buildTemplateComponents(definitionComponents, this.normaliseTemplateVariables(dto.template.variables)),
            ];
            const template: any = { name: dto.template.name, language: { code: language } };
            if (components.length > 0) template.components = components;
            return { ...base, type: 'template', template };
        }
        if (dto.attachments?.length) {
            const att = dto.attachments[0];
            const mediaType = this.waMediaType(att.mimeType);
            const payload: any = { ...base, type: mediaType, [mediaType]: { link: att.url } };
            if (mediaType === 'document' && att.filename) payload[mediaType].filename = att.filename;
            const caption = allQuickReplies.length > 0 ? this.buildQuickReplyText(dto.text, allQuickReplies) : dto.text;
            if (caption && ['image', 'video', 'document'].includes(mediaType)) payload[mediaType].caption = caption;
            if (dto.replyToMessageId) payload.context = { message_id: dto.replyToMessageId };
            return payload;
        }
        if (allQuickReplies.length > WHATSAPP_LIST_LIMIT) {
            const payload: any = { ...base, type: 'text', text: { body: dto.text ?? '', preview_url: false } };
            if (dto.replyToMessageId) payload.context = { message_id: dto.replyToMessageId };
            return payload;
        }
        if (quickReplies.length > 0) {
            const payload: any = quickReplies.length <= WHATSAPP_BUTTON_LIMIT
                ? {
                    ...base,
                    type: 'interactive',
                    interactive: {
                        type: 'button',
                        body: { text: dto.text ?? '' },
                        action: {
                            buttons: quickReplies.map((reply, index) => ({
                                type: 'reply',
                                reply: {
                                    id: this.buildWhatsAppReplyId(reply, index),
                                    title: this.truncate(reply.title, WHATSAPP_BUTTON_TITLE_LIMIT),
                                },
                            })),
                        },
                    },
                }
                : {
                    ...base,
                    type: 'interactive',
                    interactive: {
                        type: 'list',
                        body: { text: dto.text ?? '' },
                        action: {
                            button: 'Choose option',
                            sections: [
                                {
                                    title: 'Options',
                                    rows: quickReplies.map((reply, index) => ({
                                        id: this.buildWhatsAppReplyId(reply, index),
                                        title: this.truncate(reply.title, WHATSAPP_LIST_ROW_TITLE_LIMIT),
                                    })),
                                },
                            ],
                        },
                    },
                };
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

    private buildMetaMessaging(dto: OutboundPayloadInput): any {
        const recipient = { id: dto.to };
        const message: any = {};
        const quickReplies = this.normaliseQuickReplies(dto.quickReplies, META_QUICK_REPLY_LIMIT);
        if (dto.text) message.text = dto.text;
        if (dto.attachments?.length) {
            const att = dto.attachments[0];
            const type = att.mimeType?.startsWith('image/') ? 'image' : att.mimeType?.startsWith('video/') ? 'video' : att.mimeType?.startsWith('audio/') ? 'audio' : 'file';
            message.attachment = { type, payload: { url: att.url, is_reusable: true } };
        }
        if (quickReplies.length > 0) {
            message.quick_replies = quickReplies.map((qr) => ({
                content_type: 'text',
                title: this.truncate(qr.title, WHATSAPP_BUTTON_TITLE_LIMIT),
                payload: qr.payload,
            }));
        }
        if (dto.replyToMessageId) message.reply_to = { mid: dto.replyToMessageId };
        return { recipient, message };
    }

    private buildEmailPayload(dto: OutboundPayloadInput): any {
        return { to: dto.to, subject: dto.subject ?? '(no subject)', text: dto.text, html: dto.htmlBody, attachments: dto.attachments ?? [], headers: dto.emailHeaders ?? {} };
    }

    private buildSmsPayload(dto: OutboundPayloadInput): any {
        return {
            to: dto.to,
            text: dto.text ?? '',
            country: dto.country ?? '91',
        };
    }

    private buildExotelCallPayload(dto: OutboundPayloadInput): any {
        return {
            to: dto.to,
            from: dto.from ?? null,
            record: dto.record ?? false,
        };
    }

    private normaliseQuickReplies(value: unknown, limit = Number.POSITIVE_INFINITY): QuickReplyOption[] {
        if (!Array.isArray(value)) return [];

        const replies: QuickReplyOption[] = [];
        for (const option of value) {
            if (!option || typeof option !== 'object') continue;

            const raw = option as Record<string, unknown>;
            const title = typeof raw.title === 'string' ? raw.title.trim() : '';
            const payload = typeof raw.payload === 'string' ? raw.payload.trim() : title;
            const resolvedTitle = title || payload;
            const resolvedPayload = payload || resolvedTitle;
            if (!resolvedTitle || !resolvedPayload) continue;

            replies.push({ title: resolvedTitle, payload: resolvedPayload });
            if (replies.length >= limit) break;
        }

        return replies;
    }

    private applyQuickReplyTextFallback(
        channelType: string,
        text: string | null | undefined,
        quickReplies: QuickReplyOption[],
    ): string | null | undefined {
        const needsTextFallback = TEXT_QUICK_REPLY_FALLBACK_CHANNELS.has(channelType)
            || (channelType === 'whatsapp' && quickReplies.length > WHATSAPP_LIST_LIMIT);
        if (!needsTextFallback || quickReplies.length === 0) {
            return text;
        }

        return this.buildQuickReplyText(text, quickReplies);
    }

    private buildQuickReplyText(text: string | null | undefined, quickReplies: QuickReplyOption[]): string {
        const base = (text ?? '').trim();
        const options = quickReplies
            .map((reply, index) => `${index + 1}. ${reply.payload || reply.title}`)
            .join('\n');

        return `${base}${base ? '\n\n' : ''}Options:\n${options}`;
    }

    private appendQuickRepliesToHtml(
        htmlBody: string | null | undefined,
        quickReplies: QuickReplyOption[],
    ): string | null | undefined {
        if (!htmlBody || quickReplies.length === 0) return htmlBody;

        const options = quickReplies
            .map((reply) => `<li>${this.escapeHtml(reply.payload || reply.title)}</li>`)
            .join('');

        return `${htmlBody}<p><strong>Options:</strong></p><ol>${options}</ol>`;
    }

    private normaliseEmailUnsubscribe(value: unknown): { url: string; token?: string } | null {
        if (!value || typeof value !== 'object') return null;
        const raw = value as Record<string, unknown>;
        const url = typeof raw.url === 'string' ? raw.url.trim() : '';
        if (!url) return null;
        const token = typeof raw.token === 'string' ? raw.token : undefined;
        return { url, token };
    }

    private appendUnsubscribeText(
        text: string | null | undefined,
        url: string,
    ): string | null | undefined {
        const base = text ?? '';
        const footer = `Unsubscribe: ${url}`;
        return base.includes(url) ? base : `${base}${base.trim() ? '\n\n' : ''}${footer}`;
    }

    private appendUnsubscribeHtml(
        htmlBody: string | null | undefined,
        url: string,
    ): string | null | undefined {
        if (!htmlBody || htmlBody.includes(url)) return htmlBody;
        const escapedUrl = this.escapeHtml(url);
        return `${htmlBody}<p style="font-size:12px;color:#667085;margin-top:24px"><a href="${escapedUrl}">Unsubscribe</a></p>`;
    }

    private buildWhatsAppReplyId(reply: QuickReplyOption, index: number): string {
        const id = (reply.payload || reply.title || `option_${index + 1}`).trim();
        return this.truncate(id || `option_${index + 1}`, WHATSAPP_INTERACTIVE_ID_LIMIT);
    }

    private truncate(value: string, maxLength: number): string {
        return value.length > maxLength ? value.slice(0, maxLength) : value;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }


    // ─── Helpers ───────────────────────────────────────────────────────────────

    private async claimBroadcastRecipient(
        params: SendMessageDto,
        workspaceId: string,
    ): Promise<BroadcastRecipientClaim> {
        if (!params.broadcastRecipientId) return { skip: false };

        const recipient = await this.prisma.broadcastRecipient.findFirst({
            where: { id: params.broadcastRecipientId, workspaceId },
            include: { message: true },
        });
        if (!recipient) {
            throw new NotFoundException('Broadcast recipient not found');
        }

        if (BROADCAST_RECIPIENT_TERMINAL_STATUSES.has(recipient.status)) {
            return { skip: true, message: recipient.message ?? undefined };
        }

        const staleBefore = new Date(Date.now() - BROADCAST_SENDING_LOCK_STALE_MS);
        const claimed = await this.prisma.broadcastRecipient.updateMany({
            where: {
                id: recipient.id,
                workspaceId,
                OR: [
                    { status: { in: ['pending', 'queued', 'failed'] } },
                    ...(params.queueAttempt
                        ? [{ status: 'sending', attempts: { lt: params.queueAttempt } }]
                        : []),
                    { status: 'sending', updatedAt: { lt: staleBefore } },
                ],
            },
            data: {
                status: 'sending',
                attempts: params.queueAttempt ?? recipient.attempts + 1,
                maxRetries: params.queueMaxRetries ?? recipient.maxRetries,
                lastError: null,
            },
        });

        if (!claimed.count) {
            const current = await this.prisma.broadcastRecipient.findFirst({
                where: { id: recipient.id, workspaceId },
                include: { message: true },
            });
            return { skip: true, message: current?.message ?? undefined };
        }

        return { skip: false };
    }

    private async failBroadcastRecipientForSend(
        params: SendMessageDto,
        workspaceId: string,
        err: any,
        _messageId?: string,
    ) {
        if (!params.broadcastRecipientId) return;
        const isFinalAttempt =
            !!params.queueAttempt &&
            !!params.queueMaxRetries &&
            params.queueAttempt >= params.queueMaxRetries;
        await this.prisma.broadcastRecipient.updateMany({
            where: { id: params.broadcastRecipientId, workspaceId },
            data: {
                status: isFinalAttempt ? 'dead_letter' : 'failed',
                failedAt: new Date(),
                attempts: params.queueAttempt ?? undefined,
                maxRetries: params.queueMaxRetries ?? undefined,
                lastError: this.displayErrorMessage(err),
            },
        });
    }

    private displayErrorMessage(err: unknown): string {
        if (err instanceof BadRequestException) {
            const response = err.getResponse();
            if (response && typeof response === 'object') {
                const message = (response as { message?: unknown }).message;
                if (Array.isArray(message)) return message.join(', ');
                if (typeof message === 'string' && message.trim()) return message;
            }
            if (typeof response === 'string' && response.trim()) return response;
        }

        if (
            err &&
            typeof err === 'object' &&
            'message' in err &&
            typeof (err as { message?: unknown }).message === 'string' &&
            (err as { message: string }).message.trim()
        ) {
            return (err as { message: string }).message;
        }

        return String(err);
    }

    private async finalise(
        messageId: string,
        externalId: string | undefined,
        conversationId: string,
        workspaceId: string,
        channelId: string,
        opts: { renderedText?: string | null; renderedSubject?: string | null } = {},
    ) {
        const message = await this.prisma.message.update({
            where: { id: messageId },
            data: {
                status: 'sent',
                channelMsgId: externalId ?? null,
                sentAt: new Date(),
            },
            include: { channel: true, author: true },
        });
        await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageId: messageId, lastMessageAt: new Date() } });
        this.events.emit('message.outbound', { workspaceId, channelId, conversationId, messageId, externalId });
        this.events.emit('message.status_updated', {
            workspaceId,
            conversationId,
            messageId,
            status: 'sent',
        });
        await this.reconcileBroadcastRecipientFromMessage(message, 'sent', {
            providerMessageId: externalId ?? null,
            renderedText: opts.renderedText,
            renderedSubject: opts.renderedSubject,
        });
        return message;
    }

    private async reconcileBroadcastRecipientFromMessage(
        message: {
            id: string;
            workspaceId: string;
            broadcastRecipientId?: string | null;
            channelMsgId?: string | null;
        },
        status: 'sent' | 'delivered' | 'read' | 'failed' | 'bounced' | 'unsubscribed' | 'dead_letter',
        opts: {
            providerMessageId?: string | null;
            lastError?: string | null;
            attempts?: number;
            maxRetries?: number;
            renderedText?: string | null;
            renderedSubject?: string | null;
        } = {},
    ) {
        if (!message.broadcastRecipientId) return;

        const recipient = await this.prisma.broadcastRecipient.findFirst({
            where: { id: message.broadcastRecipientId, workspaceId: message.workspaceId },
            select: { status: true },
        });
        if (!recipient) return;

        const currentRank = BROADCAST_RECIPIENT_STATUS_RANK[recipient.status] ?? 0;
        const nextRank = BROADCAST_RECIPIENT_STATUS_RANK[status] ?? 0;
        if (nextRank < currentRank) return;

        const now = new Date();
        await this.prisma.broadcastRecipient.updateMany({
            where: { id: message.broadcastRecipientId, workspaceId: message.workspaceId },
            data: {
                status,
                providerMessageId: opts.providerMessageId ?? message.channelMsgId ?? undefined,
                lastError: opts.lastError ?? null,
                attempts: opts.attempts ?? undefined,
                maxRetries: opts.maxRetries ?? undefined,
                renderedText: opts.renderedText ?? undefined,
                renderedSubject: opts.renderedSubject ?? undefined,
                ...(status === 'sent' ? { sentAt: now } : {}),
                ...(status === 'delivered' ? { deliveredAt: now } : {}),
                ...(status === 'read' ? { readAt: now, deliveredAt: now } : {}),
                ...(status === 'failed' || status === 'bounced' || status === 'dead_letter'
                    ? { failedAt: now }
                    : {}),
                ...(status === 'unsubscribed' ? { unsubscribedAt: now } : {}),
            },
        });
    }

    private async updateContactChannelWindowForOutbound(opts: {
        contactChannelId?: string | null;
        channelType: string;
        eventTimestamp?: string | number | null;
        metadata?: Record<string, any> | null;
    }) {
        if (!opts.contactChannelId) return;

        const eventTimeMs = this.toEpochMs(opts.eventTimestamp) ?? Date.now();
        const nextWindowCategory = this.extractConversationWindowCategory(opts.metadata);
        const nextCallPermission = this.extractNullableBoolean(opts.metadata?.call_permission);
        const nextPermanentCallPermission = this.extractBoolean(opts.metadata?.hasPermanentCallPermission);
        const explicitExpiry = this.toEpochMs(opts.metadata?.messageWindowExpiry);

        await this.prisma.contactChannel.update({
            where: { id: opts.contactChannelId },
            data: {
                lastMessageTime: BigInt(Math.trunc(eventTimeMs)),
                ...(explicitExpiry ? { messageWindowExpiry: BigInt(Math.trunc(explicitExpiry)) } : {}),
                ...(nextWindowCategory !== undefined
                    ? { conversationWindowCategory: nextWindowCategory as any }
                    : {}),
                ...(nextCallPermission !== undefined ? { call_permission: nextCallPermission } : {}),
                ...(nextPermanentCallPermission !== undefined
                    ? { hasPermanentCallPermission: nextPermanentCallPermission }
                    : {}),
            },
        });
    }

    private extractConversationWindowCategory(metadata: any): Record<string, any> | undefined {
        if (!metadata) return undefined;
        if (metadata.conversationWindowCategory && typeof metadata.conversationWindowCategory === 'object') {
            return metadata.conversationWindowCategory;
        }
        if (metadata.conversation?.category) {
            return { category: metadata.conversation.category };
        }
        return undefined;
    }

    private extractNullableBoolean(value: unknown): boolean | null | undefined {
        if (value === null) return null;
        if (typeof value === 'boolean') return value;
        return undefined;
    }

    private extractBoolean(value: unknown): boolean | undefined {
        if (typeof value === 'boolean') return value;
        return undefined;
    }

    private toEpochMs(value: string | number | null | undefined): number | null {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' && Number.isNaN(Number(value))) {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric)) return null;
        return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
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

    private normaliseTemplateVariables(value: any): Record<string, string> {
        if (!value) return {};

        if (Array.isArray(value)) {
            return value.reduce<Record<string, string>>((acc, item, index) => {
                acc[String(index + 1)] = String(item ?? '');
                return acc;
            }, {});
        }

        if (typeof value === 'object') {
            return Object.entries(value).reduce<Record<string, string>>((acc, [key, item]) => {
                acc[key] = String(item ?? '');
                return acc;
            }, {});
        }

        return {};
    }

    private normaliseMessengerTemplateMessage(message: any, template: MessengerTemplateCatalogItem): any {
        const attachment = message?.attachment;
        const payload = attachment?.payload;

        if (attachment?.type !== 'template' || payload?.template_type !== 'media') {
            return message;
        }

        const element = payload.elements?.[0] ?? {};
        if (element.attachment_id || this.isFacebookMediaUrl(element.url)) {
            return message;
        }

        const header = template.components?.find((component: any) => component?.type === 'HEADER');
        const body = template.components?.find((component: any) => component?.type === 'BODY');

        return {
            attachment: {
                type: 'template',
                payload: {
                    template_type: 'generic',
                    elements: [
                        {
                            title: header?.text ?? template.name,
                            subtitle: body?.text ?? template.description,
                            ...(element.url ? { image_url: element.url } : {}),
                            ...(element.buttons?.length ? { buttons: element.buttons } : {}),
                        },
                    ],
                },
            },
        };
    }

    private isFacebookMediaUrl(value: unknown): value is string {
        if (typeof value !== 'string') return false;

        try {
            const hostname = new URL(value).hostname.toLowerCase();
            return hostname === 'facebook.com' ||
                hostname.endsWith('.facebook.com') ||
                hostname === 'fbcdn.net' ||
                hostname.endsWith('.fbcdn.net');
        } catch {
            return false;
        }
    }

    private isUuid(value: unknown): value is string {
        return typeof value === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    private async resolveReplyTarget(replyToMessageId: string, conversationId: string) {
        const target = await this.prisma.message.findUnique({
            where: { id: replyToMessageId },
            include: {
                author: { select: { firstName: true, lastName: true } },
                conversation: {
                    select: {
                        contact: {
                            select: {
                                firstName: true,
                                lastName: true,
                                email: true,
                                phone: true,
                            },
                        },
                    },
                },
                messageAttachments: {
                    orderBy: { createdAt: 'asc' },
                    take: 1,
                },
            },
        });

        if (!target) {
            throw new BadRequestException('replyToMessageId was not found');
        }

        if (target.conversationId !== conversationId) {
            throw new BadRequestException('replyToMessageId does not belong to this conversation');
        }

        return target;
    }

    private buildQuotedMessagePreview(target: any) {
        if (!target) return undefined;
        const attachment = target.messageAttachments?.[0];
        return {
            id: target.id,
            text: target.text ?? undefined,
            author: this.getQuotedAuthorLabel(target),
            attachmentType: this.normaliseQuotedAttachmentType(attachment?.type),
            attachmentUrl: attachment?.url ?? undefined,
        };
    }

    private getQuotedAuthorLabel(message: any) {
        if (message.direction === 'outgoing') {
            const authorName = [message.author?.firstName, message.author?.lastName]
                .filter(Boolean)
                .join(' ')
                .trim();
            return authorName || 'You';
        }

        const contact = message.conversation?.contact;
        const contactName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
        return contactName || contact?.email || contact?.phone || 'Customer';
    }

    private normaliseQuotedAttachmentType(type?: string) {
        if (!type) return undefined;
        if (type === 'voice') return 'audio';
        if (type === 'image' || type === 'video' || type === 'audio') return type;
        return 'file';
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

        const updated = await this.prisma.message.update({
            where: { id: message.id },
            data: { status, metadata: { ...message.metadata, status } },
        });

        await this.reconcileBroadcastRecipientFromMessage(
            updated,
            status,
            status === 'failed' ? { lastError: 'Provider reported failed delivery' } : {},
        );

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

        const updated = await this.prisma.message.update({
            where: { id: message.id },
            data: {
                status: 'delivered',
                metadata: { ...message.metadata, status: 'delivered' },
            },
        });

        await this.reconcileBroadcastRecipientFromMessage(updated, 'delivered');

        this.events.emit('message.status_updated', {
            workspaceId: message.workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            status: 'delivered',
        });
    }

    async processEmailStatusUpdate(params: {
        externalId: string;
        status: 'delivered' | 'read' | 'failed' | 'bounced' | 'unsubscribed';
        recipient?: string;
    }): Promise<void> {
        const candidates = this.emailMessageIdCandidates(params.externalId);
        const message: any = await this.prisma.message.findFirst({
            where: {
                channelType: 'email',
                channelMsgId: { in: candidates },
            },
            include: {
                conversation: { select: { contactId: true } },
            },
        });

        if (!message) {
            this.logger.warn(
                `Email status for unknown message. externalId=${params.externalId} status=${params.status}`,
            );
            return;
        }

        const messageStatus =
            params.status === 'bounced' || params.status === 'unsubscribed'
                ? 'failed'
                : params.status;
        const updated = await this.prisma.message.update({
            where: { id: message.id },
            data: {
                status: messageStatus,
                metadata: {
                    ...((message.metadata as Record<string, any>) ?? {}),
                    status: params.status,
                    statusRecipient: params.recipient ?? null,
                },
            },
        });

        await this.reconcileBroadcastRecipientFromMessage(updated, params.status, {
            lastError:
                params.status === 'failed' || params.status === 'bounced'
                    ? `Email provider reported ${params.status}`
                    : null,
        });

        if (params.status === 'unsubscribed' && message.conversation?.contactId) {
            await this.prisma.contact.update({
                where: { id: message.conversation.contactId },
                data: { marketingOptOut: true },
            });
        }

        this.events.emit('message.status_updated', {
            workspaceId: message.workspaceId,
            conversationId: message.conversationId,
            messageId: message.id,
            status: messageStatus,
        });
    }

    private emailMessageIdCandidates(externalId: string): string[] {
        const trimmed = externalId.trim();
        const withoutAngles = trimmed.replace(/^<|>$/g, '');
        return Array.from(new Set([trimmed, withoutAngles, `<${withoutAngles}>`])).filter(Boolean);
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
                broadcastRecipientId: true,
                channelMsgId: true,
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
            await this.reconcileBroadcastRecipientFromMessage(message, 'read');
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
        const normalizedRecipientIdentifier =
            normalizeContactIdentifierForChannel(channelType, recipientIdentifier) ??
            recipientIdentifier?.trim();
        const normalizedChannelMsgId = channelMsgId?.trim();
        if (!normalizedRecipientIdentifier || !normalizedChannelMsgId) {
            this.logger.warn(
                `ExternalOutbound ignored: missing recipient/message id channel=${channelId} channelMsgId=${channelMsgId ?? 'missing'}`,
            );
            return;
        }

        // ── 1. Dedup ───────────────────────────────────────────────────────────
        // If our system already created this message (sendMessage saved channelMsgId),
        // the echo arrives and we skip it cleanly.

        const existing = await this.prisma.message.findFirst({
            where: { channelMsgId: normalizedChannelMsgId, channelId },
            select: { id: true },
        });

        if (existing) {
            const existingMessage = await this.prisma.message.findUnique({
                where: { id: existing.id },
                select: { metadata: true },
            });

            await this.prisma.message.update({
                where: { id: existing.id },
                data: {
                    sentAt: timestamp ? new Date(timestamp) : new Date(),
                    metadata: {
                        ...((existingMessage?.metadata as Record<string, any>) ?? {}),
                        ...(metadata ?? {}),
                        echoUpdatedAt: new Date(),
                    },
                },
            });

            this.logger.debug(
                `ExternalOutbound: already stored channelMsgId=${channelMsgId} —${timestamp} Updating echo timestamp`,
            );
            return;
        }

        // ── 2. Upsert Contact + ContactChannel ────────────────────────────────
        // Same logic as InboundService.upsertContact() but we use recipientIdentifier.
        // The "contact" here is the customer the agent was talking to.

        const { contact, contactChannel } = await this.upsertContactForExternal({
            workspaceId,
            channelId,
            channelType,
            identifier: normalizedRecipientIdentifier,
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
                channelMsgId: normalizedChannelMsgId,
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

        await this.updateContactChannelWindowForOutbound({
            contactChannelId: contactChannel?.id,
            channelType,
            eventTimestamp: timestamp ?? Date.now(),
            metadata,
        });

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
            if (
                profile?.avatarUrl &&
                isMissingOrStaticContactAvatarUrl(existing.contact.avatarUrl)
            ) {
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
                avatarUrl: resolveContactAvatarUrl(profile?.avatarUrl),
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
                contact: { OR: [{ status: { not: 'closed' } }, { status: null }] },
            },
            orderBy: { updatedAt: 'desc' },
        });

        if (existing) {
            return this.prisma.conversation.update({
                where: { id: existing.id },
                data: { updatedAt: new Date() },
            });
        }

        await this.prisma.contact.update({
            where: { id: contactId },
            data: { status: 'open' },
        });

        return this.prisma.conversation.create({
            data: {
                workspaceId,

                contactId,
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

    private buildTemplateContext(
        contact: { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null },
        author: { firstName?: string | null; lastName?: string | null } | null,
        lastMessage: string | null,
    ) {
        const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
            || contact.email
            || contact.phone
            || 'there';
        const agentName = author
            ? [author.firstName, author.lastName].filter(Boolean).join(' ').trim()
            : '';

        return {
            contact_name: contactName,
            contact_first_name: contact.firstName?.trim() || '',
            contact_last_name: contact.lastName?.trim() || '',
            contact_email: contact.email?.trim() || '',
            contact_phone: contact.phone?.trim() || '',
            agent_name: agentName || 'Agent',
            last_message: lastMessage?.trim() || '',
        };
    }

    private renderVariables(value: string | null | undefined, context: Record<string, string>, fieldName: string) {
        if (!value) {
            return value ?? undefined;
        }

        const allowedKeys = new Set(Object.keys(context));
        const usedKeys = Array.from(value.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)).map((match) => match[1]);
        const invalidKeys = usedKeys.filter((key) => !allowedKeys.has(key));

        if (invalidKeys.length > 0) {
            throw new BadRequestException(`Unsupported variables in ${fieldName}: ${Array.from(new Set(invalidKeys)).join(', ')}`);
        }

        return value.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => context[key] ?? '');
    }

    private renderTemplateVariables(
        value: any,
        context: Record<string, string>,
        fieldName: string,
    ): Record<string, string> {
        const variables = this.normaliseTemplateVariables(value);

        return Object.entries(variables).reduce<Record<string, string>>((acc, [key, entry]) => {
            acc[key] = this.renderVariables(entry, context, `${fieldName} ${key}`) ?? '';
            return acc;
        }, {});
    }

    private renderTemplateValue(value: any, variables: Record<string, string>): any {
        if (typeof value === 'string') {
            return value.replace(
                /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
                (_match, key: string) => variables[key] ?? '',
            );
        }

        if (Array.isArray(value)) {
            return value.map((entry) => this.renderTemplateValue(entry, variables));
        }

        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value).map(([key, entry]) => [
                    key,
                    this.renderTemplateValue(entry, variables),
                ]),
            );
        }

        return value;
    }

    private async ensureSendableContactChannel(opts: {
        workspaceId: string;
        channel: { id: string; type: string };
        contact: { id: string; email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null };
        contactChannel: any | null;
    }) {
        const { workspaceId, channel, contact } = opts;
        if (opts.contactChannel?.identifier) {
            return opts.contactChannel;
        }

        let identifier: string | null = null;
        if (channel.type === 'whatsapp') {
            identifier = normalizeContactIdentifierForChannel(channel.type, contact.phone);
        } else if (channel.type === 'email') {
            identifier = normalizeContactIdentifierForChannel(channel.type, contact.email);
        } else {
            return opts.contactChannel;
        }

        if (!identifier) {
            return opts.contactChannel;
        }

        const existing = await this.prisma.contactChannel.findFirst({
            where: {
                channelId: channel.id,
                identifier,
            },
            include: { contact: true },
        });

        if (existing) {
            if (existing.contactId !== contact.id) {
                this.logger.warn(
                    `Send fallback found existing contactChannel on another contact. channelId=${channel.id} identifier=${identifier} existingContactId=${existing.contactId} requestedContactId=${contact.id}`,
                );
                return opts.contactChannel;
            }
            return existing;
        }

        this.logger.log(
            `Creating missing contactChannel for outbound send. channelType=${channel.type} channelId=${channel.id} contactId=${contact.id} identifier=${identifier}`,
        );

        return this.prisma.contactChannel.create({
            data: {
                workspaceId,
                contactId: contact.id,
                channelId: channel.id,
                channelType: channel.type,
                identifier,
                displayName: [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null,
            },
        });
    }


}
