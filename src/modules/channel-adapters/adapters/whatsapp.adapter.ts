// modules/channels/providers/whatsapp/whatsapp.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
    ChannelProvider,
    ParsedInbound,
    ParsedAttachment,
    DownloadResult,
    ContactProfile,
    ValidateOutboundOpts,
} from '../channel-adapter.interface';

const GRAPH = 'https://graph.facebook.com/v19.0';

@Injectable()
export class WhatsAppProvider implements ChannelProvider {
    readonly type = 'whatsapp';
    private readonly logger = new Logger(WhatsAppProvider.name);

    constructor() { }


    // ─── sendMessage ───────────────────────────────────────────────────────────

    async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
        const token = channel.credentials?.accessToken;
        const phoneNumberId = channel.identifier;

        console.warn(`Sending WhatsApp message to ${JSON.stringify(payload)} via phoneNumberId ${phoneNumberId} with token ${token ? '***' : 'MISSING'}`);
        console.dir({ payload }, { depth: null });

        const { data } = await axios.post(
            `${GRAPH}/${phoneNumberId}/messages`,
            {
                ...(payload)
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
        );
        console.log({data});
        

        return { externalId: data?.messages?.[0]?.id };
    }
    // templates capability wired to WhatsAppTemplatesService
  

    // ─── parseWebhook ──────────────────────────────────────────────────────────

    async parseWebhook(body: any): Promise<ParsedInbound[]> {
        const results: ParsedInbound[] = [];

        for (const entry of body?.entry ?? []) {
            for (const change of entry?.changes ?? []) {
                if (change.field !== 'messages') continue;

                const val = change.value;

                // messages
                for (const msg of val?.messages ?? []) {
                    try {
                        const parsed = this.parseMessage(msg, val);
                        if (parsed) results.push(parsed);
                    } catch (e) {
                        this.logger.error(`WA parse error: ${e.message}`);
                    }
                }

                // statuses
                for (const status of val?.statuses ?? []) {
                    const parsed = this.parseStatus(status, val);
                    if (parsed) results.push(parsed);
                }
            }
        }

        return results;
    }
    private parseStatus(status: any, val: any): any {
        return {
            externalId: status.id,
            contactIdentifier: status.recipient_id,
            direction: 'outgoing',

            messageType: 'status',

            metadata: {
                status: status.status,        // sent | delivered | read | failed
                timestamp: status.timestamp,
                conversation: status.conversation,
                pricing: status.pricing
            },

            raw: { status, metadata: val?.metadata },
            attachments: []
        };
    }

    private parseMessage(msg: any, val: any): ParsedInbound | null {
        const from: string = msg.from;
        const msgId: string = msg.id;

        const base = {
            externalId: msgId,
            contactIdentifier: from,
            direction: 'incoming' as const,
            replyToChannelMsgId: msg.context?.id,
            timestamp: msg.timestamp,
            raw: { msg, metadata: val?.metadata },
        };

        switch (msg.type) {
            case 'text':
                return { ...base, messageType: 'text', text: msg.text?.body, attachments: [] };

            case 'image':
                return { ...base, messageType: 'image', attachments: [this.mediaAtt('image', msg.image)] };

            case 'video':
                return { ...base, messageType: 'video', attachments: [this.mediaAtt('video', msg.video)] };

            case 'audio':
                return { ...base, messageType: 'audio', attachments: [this.mediaAtt('audio', msg.audio)] };

            case 'voice':
                return { ...base, messageType: 'voice', attachments: [this.mediaAtt('voice', msg.audio ?? msg.voice)] };

            case 'document':
                return {
                    ...base, messageType: 'document', attachments: [{
                        type: 'document',
                        externalMediaId: msg.document?.id,
                        mimeType: msg.document?.mime_type,
                        filename: msg.document?.filename,
                        caption: msg.document?.caption,
                    }]
                };

            case 'sticker':
                return {
                    ...base, messageType: 'sticker', attachments: [{
                        type: 'sticker',
                        externalMediaId: msg.sticker?.id,
                        mimeType: msg.sticker?.mime_type,
                        stickerId: msg.sticker?.id,
                    }]
                };

            case 'location':
                return {
                    ...base, messageType: 'location', attachments: [{
                        type: 'location',
                        latitude: msg.location?.latitude,
                        longitude: msg.location?.longitude,
                        locationName: msg.location?.name,
                        locationAddress: msg.location?.address,
                    }]
                };

            case 'contacts':
                return {
                    ...base, messageType: 'contact', attachments: (msg.contacts ?? []).map((c: any) => ({
                        type: 'contact',
                        contactVcard: this.buildVcard(c),
                        caption: `${c.name?.formatted_name ?? ''}`,
                    }))
                };

            case 'reaction':
                return {
                    ...base, messageType: 'reaction', attachments: [{
                        type: 'reaction',
                        reactionEmoji: msg.reaction?.emoji,
                        reactionTargetMsgId: msg.reaction?.message_id,
                    }]
                };

            case 'interactive': {
                const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
                return { ...base, messageType: 'interactive', text: reply?.title, attachments: [], metadata: { interactive: msg.interactive } };
            }

            case 'order':
                return { ...base, messageType: 'order', attachments: [], metadata: { order: msg.order } };

            case 'template':
                return { ...base, messageType: 'template', attachments: [], metadata: { template: msg.template } };

            case 'system':
                return null; // ignore system messages (number changes, etc.)

            default:
                this.logger.warn(`Unknown WA message type: ${msg.type}`);
                return { ...base, messageType: 'unsupported', attachments: [{ type: 'unsupported', caption: `[${msg.type}]` }] };
        }
    }

    private mediaAtt(type: ParsedAttachment['type'], obj: any): ParsedAttachment {
        return {
            type,
            externalMediaId: obj?.id,
            mimeType: obj?.mime_type,
            caption: obj?.caption,
        };
    }

    private buildVcard(contact: any): string {
        const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
        if (contact.name?.formatted_name) lines.push(`FN:${contact.name.formatted_name}`);
        for (const phone of contact.phones ?? []) {
            lines.push(`TEL;TYPE=${phone.type ?? 'CELL'}:${phone.phone}`);
        }
        for (const email of contact.emails ?? []) {
            lines.push(`EMAIL:${email.email}`);
        }
        lines.push('END:VCARD');
        return lines.join('\n');
    }

    // ─── downloadMedia ─────────────────────────────────────────────────────────

    async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
        const token = channel.credentials?.accessToken;

        // Step 1: get media URL
        const { data: meta } = await axios.get(`${GRAPH}/${mediaId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        // Step 2: download bytes
        const { data, headers } = await axios.get<ArrayBuffer>(meta.url, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer',
        });

        return {
            buffer: data,
            mimeType: meta.mime_type ?? (headers['content-type'] as string)?.split(';')[0] ?? 'application/octet-stream',
        };
    }

    // ─── getContactProfile ─────────────────────────────────────────────────────

    async getContactProfile(_identifier: string, _channel: any): Promise<ContactProfile> {
        // WhatsApp Cloud API does not expose profile info
        return {};
    }

    // ─── uploadMedia ───────────────────────────────────────────────────────────

    //   async uploadMedia(channel: any, opts: { url: string; mimeType: string; type?: string }): Promise<string> {
    //     const token         = channel.config?.accessToken;
    //     const phoneNumberId = channel.identifier || channel.config?.phoneNumberId;

    //     const { data: fileBuffer } = await axios.get<ArrayBuffer>(opts.url, { responseType: 'arraybuffer' });

    //     const form = new FormData();
    //     const blob = new Blob([fileBuffer], { type: opts.mimeType });
    //     form.append('file', blob);
    //     form.append('type', opts.mimeType);
    //     form.append('messaging_product', 'whatsapp');

    //     const { data } = await axios.post(
    //       `${GRAPH}/${phoneNumberId}/media`,
    //       form,
    //       { headers: { Authorization: `Bearer ${token}` } },
    //     );

    //     return data.id;
    //   }



    // ─── markRead ──────────────────────────────────────────────────────────────

    async markRead(channel: any, externalId: string): Promise<void> {
        const token = channel.credentials?.accessToken;
        const phoneNumberId = channel.identifier;

        await axios.post(
            `${GRAPH}/${phoneNumberId}/messages`,
            { messaging_product: 'whatsapp', status: 'read', message_id: externalId },
            { headers: { Authorization: `Bearer ${token}` } },
        );
    }

    // ─── validateOutbound ──────────────────────────────────────────────────────

    validateOutbound({ channel, contactChannel, contact }: ValidateOutboundOpts): void {
        const { BadRequestException } = require('@nestjs/common');

        if (!channel.credentials?.accessToken) {
            throw new BadRequestException({
                code: 'CHANNEL_MISSING_CREDENTIAL',
                message: 'WhatsApp access token is missing. Reconnect the channel in Settings.',
                retryable: false,
            });
        }

        if (!channel.identifier) {
            throw new BadRequestException({
                code: 'CHANNEL_MISSING_CREDENTIAL',
                message: 'WhatsApp Phone Number ID is missing. Reconnect the channel in Settings.',
                retryable: false,
            });
        }

        const to = contactChannel?.identifier ?? contact.phone;
        if (!to) {
            throw new BadRequestException({
                code: 'CONTACT_NO_IDENTIFIER',
                message: 'This contact has no WhatsApp phone number. Add a phone number to the contact first.',
                retryable: false,
            });
        }
    }

    // ─── normaliseError ────────────────────────────────────────────────────────

    normaliseError(err: any): never {
        const { BadRequestException } = require('@nestjs/common');
        const waError = err?.response?.data?.error;
        const status = err?.response?.status;
        const code: number = waError?.code ?? 0;
        const detail = waError?.message ?? err.message;

        if (status === 401 || code === 190)
            throw new BadRequestException({ code: 'WA_INVALID_TOKEN', message: 'WhatsApp access token expired. Reconnect in Settings.', detail, retryable: false });
        if (code === 131026)
            throw new BadRequestException({ code: 'WA_PHONE_NOT_FOUND', message: 'The recipient\'s phone number is not on WhatsApp.', detail, retryable: false });
        if (code === 131047 || code === 131021)
            throw new BadRequestException({ code: 'WA_OUTSIDE_WINDOW', message: 'The 24-hour messaging window is closed. Use a pre-approved template to re-open the conversation.', detail, retryable: false });
        if (code === 132000 || code === 132001)
            throw new BadRequestException({ code: 'WA_TEMPLATE_REJECTED', message: 'Template not approved. Check status in Meta Business Manager.', detail, retryable: false });
        if (code === 130429 || code === 131048 || status === 429)
            throw new BadRequestException({ code: 'WA_RATE_LIMITED', message: 'WhatsApp rate limit reached. Wait before retrying.', detail, retryable: true });
        if (code === 131031)
            throw new BadRequestException({ code: 'WA_RECIPIENT_BLOCKED', message: 'The contact has blocked your WhatsApp Business number.', detail, retryable: false });
        if (code === 10 || code === 200 || code === 294)
            throw new BadRequestException({ code: 'WA_PERMISSION_DENIED', message: 'Your WhatsApp Business account lacks permission. Check Meta Business Manager.', detail, retryable: false });
        if (code === 131053 || code === 131052)
            throw new BadRequestException({ code: 'WA_MEDIA_UPLOAD_FAILED', message: 'Media upload failed. Check the file size and format.', detail, retryable: true });

        throw new BadRequestException({ code: 'PROVIDER_ERROR', message: 'Message could not be sent.', detail, retryable: true });
    }
}
