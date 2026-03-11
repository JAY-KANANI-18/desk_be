// src/channels/providers/whatsapp.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
    ChannelProvider,
    ParsedInbound,
    ParsedAttachment,
    DownloadResult,
    ContactProfile,
} from '../channel-provider.interface';

const GRAPH = 'https://graph.facebook.com/v19.0';

@Injectable()
export class WhatsAppProvider implements ChannelProvider {
    readonly type = 'whatsapp';


    // ─── sendMessage ─────────────────────────────────────────────────────────

    async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
        const token = channel.config?.accessToken;
        const phoneNumberId = channel.identifier;

        console.warn(`Sending WhatsApp message to ${JSON.stringify(payload)} via phoneNumberId ${phoneNumberId} with token ${token ? '***' : 'MISSING'}`);
        console.dir({payload}, { depth: null });

        const { data } = await axios.post(
            `${GRAPH}/${phoneNumberId}/messages`,
            {
                    ...(payload)
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
        );

        return { externalId: data?.messages?.[0]?.id };
    }
    // ─── parseWebhook ────────────────────────────────────────────────────────

    async parseWebhook(body: any): Promise<ParsedInbound[]> {
        const results: ParsedInbound[] = [];

        for (const change of body?.entry?.[0]?.changes ?? []) {
            if (change.field !== 'messages') continue;

            const value = change.value;
            for (const msg of value?.messages ?? []) {
                const contact = value?.contacts?.[0];
                try {
                    const parsed = this.parseMsg(msg, contact);
                    if (parsed) results.push(parsed);
                } catch (e) {
                    // this.logger.error(`WA parse error msgId=${msg.id}: ${e.message}`);
                }
            }
        }

        return results;
    }

    private parseMsg(msg: any, contact?: any): ParsedInbound | null {
        const base = {
            externalId: msg.id,
            contactIdentifier: msg.from,
            direction: 'incoming' as const,
            replyToChannelMsgId: msg.context?.id,
            raw: msg,
        };

        switch (msg.type) {

            case 'text':
                return { ...base, messageType: 'text', text: msg.text?.body, attachments: [] };

            case 'image':
                return {
                    ...base, messageType: 'image',
                    text: msg.image?.caption,
                    attachments: [{ type: 'image', mimeType: msg.image?.mime_type, externalMediaId: msg.image?.id, caption: msg.image?.caption }],
                };

            case 'video':
                return {
                    ...base, messageType: 'video',
                    text: msg.video?.caption,
                    attachments: [{ type: 'video', mimeType: msg.video?.mime_type, externalMediaId: msg.video?.id, caption: msg.video?.caption, duration: msg.video?.duration }],
                };

            case 'audio':
                return {
                    ...base, messageType: msg.audio?.voice ? 'voice' : 'audio',
                    attachments: [{ type: msg.audio?.voice ? 'voice' : 'audio', mimeType: msg.audio?.mime_type, externalMediaId: msg.audio?.id, duration: msg.audio?.duration }],
                };

            case 'document':
                return {
                    ...base, messageType: 'document',
                    text: msg.document?.caption,
                    attachments: [{ type: 'document', mimeType: msg.document?.mime_type, externalMediaId: msg.document?.id, filename: msg.document?.filename, caption: msg.document?.caption }],
                };

            case 'sticker':
                return {
                    ...base, messageType: 'sticker',
                    attachments: [{ type: 'sticker', mimeType: 'image/webp', externalMediaId: msg.sticker?.id, stickerId: msg.sticker?.id }],
                };

            case 'location':
                return {
                    ...base, messageType: 'location',
                    attachments: [{ type: 'location', latitude: msg.location?.latitude, longitude: msg.location?.longitude, locationName: msg.location?.name, locationAddress: msg.location?.address }],
                    metadata: { latitude: msg.location?.latitude, longitude: msg.location?.longitude, name: msg.location?.name },
                };

            case 'contacts':
                return {
                    ...base, messageType: 'contact',
                    attachments: (msg.contacts ?? []).map((c: any) => ({
                        type: 'contact' as const,
                        contactVcard: this.buildVcard(c),
                    })),
                };

            case 'reaction':
                return {
                    ...base, messageType: 'reaction',
                    attachments: [{ type: 'reaction', reactionEmoji: msg.reaction?.emoji, reactionTargetMsgId: msg.reaction?.message_id }],
                    metadata: { emoji: msg.reaction?.emoji, targetMsgId: msg.reaction?.message_id },
                };

            case 'interactive': {
                const ir = msg.interactive;
                const text = ir?.button_reply?.title ?? ir?.list_reply?.title ?? ir?.nfm_reply?.response_json;
                return { ...base, messageType: 'interactive', text, attachments: [], metadata: ir };
            }

            case 'order':
                return {
                    ...base, messageType: 'order',
                    text: `Order: ${msg.order?.product_items?.length ?? 0} items`,
                    attachments: [],
                    metadata: msg.order,
                };

            case 'system':
            case 'ephemeral':
                return null;

            default:
                // this.logger.warn(`Unknown WA msg type: ${msg.type}`);
                return { ...base, messageType: 'unsupported', attachments: [{ type: 'unsupported' }] };
        }
    }

    // ─── downloadMedia ───────────────────────────────────────────────────────

    async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
        const token = channel.credentials?.accessToken;

        const { data: meta } = await axios.get(`${GRAPH}/${mediaId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        const { data, headers } = await axios.get<ArrayBuffer>(meta.url, {
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer',
        });

        return {
            buffer: data,
            mimeType: meta.mime_type ?? headers['content-type']?.split(';')[0] ?? 'application/octet-stream',
            filename: meta.filename,
        };
    }

    // ─── getContactProfile ───────────────────────────────────────────────────

    async getContactProfile(identifier: string, channelId: string): Promise<ContactProfile> {
        // WhatsApp Business API does NOT expose contact profile photos —
        // the name comes from the contacts[] array in the webhook payload.
        // We return an empty object; name is set from ParsedInbound.raw.
        return {};
    }

    

    // ─── markRead ────────────────────────────────────────────────────────────

    async markRead(channel: any, externalId: string): Promise<void> {
        await this.sendMessage(channel, { status: 'read', message_id: externalId });
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    private buildVcard(c: any): string {
        const name = `${c.name?.first_name ?? ''} ${c.name?.last_name ?? ''}`.trim();
        const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`];
        for (const p of c.phones ?? []) lines.push(`TEL;TYPE=${(p.type ?? 'CELL').toUpperCase()}:${p.phone}`);
        for (const e of c.emails ?? []) lines.push(`EMAIL:${e.email}`);
        lines.push('END:VCARD');
        return lines.join('\r\n');
    }
}