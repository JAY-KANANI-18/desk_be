// src/channels/providers/meta-messaging.provider.ts
//
// Handles both Instagram Messaging AND Facebook Messenger.
// They share the same webhook format (entry[].messaging[]).
// Registered twice in ChannelRegistry under 'instagram' and 'messenger'.

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
export class MetaMessagingProvider implements ChannelProvider {
  // Set per instance registration — 'instagram' | 'messenger'
  readonly type: string;

  private readonly logger = new Logger(MetaMessagingProvider.name);

  constructor(channelType: 'instagram' | 'messenger') {
    this.type = channelType;
  }

  // ─── parseWebhook ────────────────────────────────────────────────────────

  async parseWebhook(body: any): Promise<ParsedInbound[]> {
    const results: ParsedInbound[] = [];

    for (const entry of body?.entry ?? []) {
      for (const event of entry?.messaging ?? []) {
        if (event.delivery || event.read) continue;
        try {
          const parsed = this.parseEvent(event);
          if (parsed) results.push(parsed);
        } catch (e) {
          this.logger.error(`${this.type} parse error: ${e.message}`);
        }
      }
    }

    return results;
  }

  private parseEvent(event: any): ParsedInbound | null {
    const senderId: string = event.sender?.id;
    const timestamp = new Date(event.timestamp);

    const base = {
      externalId: '',
      contactIdentifier: senderId,
      direction: 'incoming' as const,
      raw: event,
    };

    // ── Reaction ─────────────────────────────────────────────────────────
    if (event.reaction) {
      return {
        ...base,
        externalId: `${event.reaction.mid}_reaction_${senderId}`,
        messageType: 'reaction',
        attachments: [{
          type: 'reaction',
          reactionEmoji: event.reaction.emoji,
          reactionTargetMsgId: event.reaction.mid,
        }],
        metadata: { action: event.reaction.action, emoji: event.reaction.emoji },
      };
    }

    // ── Postback / button tap ─────────────────────────────────────────────
    if (event.postback) {
      return {
        ...base,
        externalId: `${senderId}_${event.timestamp}_postback`,
        messageType: 'interactive',
        text: event.postback.title ?? event.postback.payload,
        attachments: [],
        metadata: { postback: event.postback },
      };
    }

    const msg = event.message;
    if (!msg) return null;

    const replyTo: string | undefined = msg.reply_to?.mid;
    const msgBase = { ...base, externalId: msg.mid, replyToChannelMsgId: replyTo };

    // ── Deleted ───────────────────────────────────────────────────────────
    if (msg.is_deleted) {
      return { ...msgBase, messageType: 'text', text: undefined, attachments: [], metadata: { deleted: true } };
    }

    // ── Quick reply ───────────────────────────────────────────────────────
    if (msg.quick_reply) {
      return {
        ...msgBase,
        messageType: 'interactive',
        text: msg.text ?? msg.quick_reply.payload,
        attachments: [],
        metadata: { quickReply: msg.quick_reply },
      };
    }

    // ── Attachments ───────────────────────────────────────────────────────
    const attachments: ParsedAttachment[] = [];
    for (const att of msg.attachments ?? []) {
      const a = this.parseAttachment(att);
      if (a) attachments.push(a);
    }

    // Derive messageType from first attachment or text
    const messageType = attachments[0]?.type ?? 'text';

    return {
      ...msgBase,
      messageType,
      text: msg.text,
      attachments,
    };
  }

  private parseAttachment(att: any): ParsedAttachment | null {
    const p = att.payload ?? {};

    switch (att.type) {
      case 'image':
        return p.sticker_id
          ? { type: 'sticker', url: p.url, stickerId: String(p.sticker_id) }
          : { type: 'image', url: p.url };

      case 'video':
        return { type: 'video', url: p.url };

      case 'audio':
        return { type: 'audio', url: p.url };

      case 'file':
        return { type: 'document', url: p.url, filename: p.name };

      case 'location':
        return {
          type: 'location',
          latitude: p.coordinates?.lat,
          longitude: p.coordinates?.long,
          locationName: p.title,
          locationAddress: p.address,
        };

      // Instagram-specific
      case 'story_mention':
        return { type: 'story_mention', url: p.url, thumbnailUrl: p.thumbnail };

      case 'reel':
      case 'ig_reel':
        return { type: 'video', url: p.url, thumbnailUrl: p.thumbnail, caption: p.title };

      case 'share':
        return { type: 'unsupported', caption: `[Share] ${p.link ?? ''}` };

      case 'template':
        return { type: 'unsupported', caption: `[Template:${p.template_type}]` };

      default:
        this.logger.warn(`Unknown ${this.type} attachment type: ${att.type}`);
        return { type: 'unsupported' };
    }
  }

  // ─── downloadMedia ───────────────────────────────────────────────────────

  async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
    const token = channel.credentials?.accessToken;

    const { data: meta } = await axios.get(`${GRAPH}/${mediaId}`, {
      params: { fields: 'url,mime_type' },
      headers: { Authorization: `Bearer ${token}` },
    });

    const { data, headers } = await axios.get<ArrayBuffer>(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });

    return {
      buffer: data,
      mimeType: meta.mime_type ?? headers['content-type']?.split(';')[0] ?? 'application/octet-stream',
    };
  }

  // ─── getContactProfile ───────────────────────────────────────────────────

  async getContactProfile(identifier: string, channelId: string): Promise<ContactProfile> {
    // NOTE: you need to pass the channel object (with access token) here.
    // The controller currently passes channelId (string) — adjust if needed.
    // This is a best-effort implementation; callers should catch errors.
    try {
      const { data } = await axios.get(`${GRAPH}/${identifier}`, {
        params: { fields: 'name,profile_pic' },
        // headers: { Authorization: `Bearer ${token}` },  // wire token from channel
      });
      return { name: data.name, avatarUrl: data.profile_pic, raw: data };
    } catch {
      return {};
    }
  }

  // ─── sendMessage ─────────────────────────────────────────────────────────

  async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
    const token = channel.config?.accessToken;
    const pageId = channel.identifier;

    console.dir({payload}, { depth: null });
    
        try{

            const { data } = await axios.post(
                `${GRAPH}/${pageId}/messages`,
                {
                    messaging_type: 'RESPONSE',
                    ...payload,
                    
                },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
            );
            
            return { externalId: data?.message_id };
        } catch (e) {
              console.error("META ERROR:", e.response?.data || e.message);

            this.logger.error(`Failed to send message via ${this.type}: ${e.response?.data?.error?.message || e.message}`);
            throw new Error(`Meta API error: ${e.response?.data?.error?.message || e.message}`);
        }
  }
}