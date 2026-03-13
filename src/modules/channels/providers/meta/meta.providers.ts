// modules/channels/providers/meta/meta.provider.ts
//
// Shared Graph API core for Instagram AND Messenger.
// Registered in ChannelRegistry under BOTH 'instagram' and 'messenger'.
//
// Feature-specific logic lives in subfolders:
//   instagram/  — ice-breakers, IG-specific validation
//   messenger/  — persistent menu, Messenger-specific validation

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  ChannelProvider,
  ParsedInbound,
  ParsedAttachment,
  DownloadResult,
  ContactProfile,
  ValidateOutboundOpts,
} from '../../channel-provider.interface';
import { InstagramValidator } from './instagram/instagram-validator';
import { MessengerValidator } from './messenger/messenger-validator';

const GRAPH = 'https://graph.facebook.com/v19.0';

@Injectable()
export class MetaProvider implements ChannelProvider {
  // Registry key — overridden at registration time ('instagram' | 'messenger')
  // The actual type used by the registry comes from registerAs(), not this field
  readonly type = 'meta';

  private readonly logger = new Logger(MetaProvider.name);

  // ─── parseWebhook ──────────────────────────────────────────────────────────

  async parseWebhook(body: any): Promise<ParsedInbound[]> {
    const results: ParsedInbound[] = [];

    for (const entry of body?.entry ?? []) {
      for (const event of entry?.messaging ?? []) {
        if (event.delivery || event.read) continue;
        try {
          const parsed = this.parseEvent(event);
          if (parsed) results.push(parsed);
        } catch (e) {
          this.logger.error(`Meta parse error: ${e.message}`);
        }
      }
    }

    return results;
  }

  private parseEvent(event: any): ParsedInbound | null {
    const senderId: string = event.sender?.id;

    // Reaction
    if (event.reaction) {
      return {
        externalId: `${event.reaction.mid}_reaction_${senderId}`,
        contactIdentifier: senderId,
        direction: 'incoming',
        messageType: 'reaction',
        attachments: [{
          type: 'reaction',
          reactionEmoji: event.reaction.emoji,
          reactionTargetMsgId: event.reaction.mid,
        }],
        metadata: { action: event.reaction.action },
        raw: event,
      };
    }

    // Postback (button tap)
    if (event.postback) {
      return {
        externalId: `${senderId}_${event.timestamp}_postback`,
        contactIdentifier: senderId,
        direction: 'incoming',
        messageType: 'interactive',
        text: event.postback.title ?? event.postback.payload,
        attachments: [],
        metadata: { postback: event.postback },
        raw: event,
      };
    }

    const msg = event.message;
    if (!msg) return null;

    const base = {
      externalId: msg.mid,
      contactIdentifier: senderId,
      direction: 'incoming' as const,
      replyToChannelMsgId: msg.reply_to?.mid,
      raw: event,
    };

    if (msg.is_deleted) {
      return { ...base, messageType: 'text', attachments: [], metadata: { deleted: true } };
    }

    if (msg.quick_reply) {
      return {
        ...base,
        messageType: 'interactive',
        text: msg.text ?? msg.quick_reply.payload,
        attachments: [],
        metadata: { quickReply: msg.quick_reply },
      };
    }

    const attachments: ParsedAttachment[] = [];
    for (const att of msg.attachments ?? []) {
      const a = this.parseAttachment(att);
      if (a) attachments.push(a);
    }

    return {
      ...base,
      messageType: attachments[0]?.type ?? 'text',
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
      case 'video': return { type: 'video', url: p.url };
      case 'audio': return { type: 'audio', url: p.url };
      case 'file': return { type: 'document', url: p.url, filename: p.name };
      case 'location': return { type: 'location', latitude: p.coordinates?.lat, longitude: p.coordinates?.long, locationName: p.title, locationAddress: p.address };
      case 'story_mention': return { type: 'story_mention', url: p.url, thumbnailUrl: p.thumbnail };
      case 'reel':
      case 'ig_reel': return { type: 'video', url: p.url, thumbnailUrl: p.thumbnail, caption: p.title };
      case 'share': return { type: 'unsupported', caption: `[Share] ${p.link ?? ''}` };
      case 'template': return { type: 'unsupported', caption: `[Template:${p.template_type}]` };
      default:
        this.logger.warn(`Unknown Meta attachment type: ${att.type}`);
        return { type: 'unsupported' };
    }
  }

  // ─── downloadMedia ─────────────────────────────────────────────────────────

  async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
    const token = channel.config?.accessToken;
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
      mimeType: meta.mime_type ?? (headers['content-type'] as string)?.split(';')[0] ?? 'application/octet-stream',
    };
  }

  // ─── getContactProfile ─────────────────────────────────────────────────────

  async getContactProfile(identifier: string, channel: any): Promise<ContactProfile> {
    try {
      const token = channel.config?.accessToken;
      const { data } = await axios.get(`${GRAPH}/${identifier}`, {
        params: { fields: 'name,profile_pic' },
        headers: { Authorization: `Bearer ${token}` },
      });
      return { name: data.name, avatarUrl: data.profile_pic, raw: data };
    } catch {
      return {};
    }
  }

  // ─── sendMessage ───────────────────────────────────────────────────────────

  async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
    const token = channel.config?.accessToken;
    const pageId = channel.identifier;

    const body = {
      messaging_type: 'RESPONSE',
      ...payload,
    };

    console.dir({ body }, { depth: null });

    const { data } = await axios.post(
      `${GRAPH}/${pageId}/messages`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return { externalId: data?.message_id };
  }

  // ─── validateOutbound — delegates to channel-type validator ───────────────

  validateOutbound(opts: ValidateOutboundOpts): void {
    if (opts.channel.type === 'instagram') {
      InstagramValidator.validate(opts);
    } else {
      MessengerValidator.validate(opts);
    }
  }

  // ─── normaliseError ────────────────────────────────────────────────────────

  normaliseError(err: any): never {
    const { BadRequestException } = require('@nestjs/common');
    const fbErr = err?.response?.data?.error;
    const status = err?.response?.status;
    const code: number = fbErr?.code ?? 0;
    const detail = fbErr?.message ?? err.message;

    if (status === 401 || code === 190)
      throw new BadRequestException({ code: 'META_INVALID_TOKEN', message: 'Page access token expired. Reconnect in Settings.', detail, retryable: false });
    if (code === 10 || code === 200 || code === 230)
      throw new BadRequestException({ code: 'META_NO_PAGE_ACCESS', message: 'Page has not granted messaging permission. Check Meta app permissions.', detail, retryable: false });
    if (code === 551 || code === 10900 || code === 2018109)
      throw new BadRequestException({ code: 'META_USER_NOT_REACHABLE', message: 'Contact is outside the messaging window.', detail, retryable: false });
    if (code === 32 || code === 613 || status === 429)
      throw new BadRequestException({ code: 'META_RATE_LIMITED', message: 'Rate limit reached. Wait before retrying.', detail, retryable: true });

    throw new BadRequestException({ code: 'PROVIDER_ERROR', message: 'Message could not be sent.', detail, retryable: true });
  }
}