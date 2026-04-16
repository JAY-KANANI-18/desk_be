// modules/channels/providers/meta/meta.provider.ts
//
// Shared Graph API core for Instagram AND Messenger.
// Registered in ChannelAdaptersRegistry under BOTH 'instagram' and 'messenger'.
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
} from '../channel-adapter.interface';
import { InstagramValidator } from '../../channels/providers/meta/instagram/instagram-validator';
import { MessengerValidator } from '../../channels/providers/meta/messenger/messenger-validator';

const FACEBOOKGRAPH = 'https://graph.facebook.com/v22.0';
const INSTAGRAPH = 'https://graph.instagram.com/v22.0';

@Injectable()
export class MetaProvider implements ChannelProvider {
  // Registry key — overridden at registration time ('instagram' | 'messenger')
  // The actual type used by the registry comes from registerAs(), not this field
  readonly type = 'meta';

  private readonly logger = new Logger(MetaProvider.name);

  // ─── parseWebhook ──────────────────────────────────────────────────────────

  async parseWebhook(body: any): Promise<any[]> {
    const results: any = [];

    for (const entry of body?.entry ?? []) {
      const channelIdentifier = entry?.id; // Page ID for Messenger, Instagram Business Account ID for Instagram
      for (const event of entry?.messaging ?? []) {

          // MESSAGE
          if (event.message) {
            const parsed = this.parseEvent(event,channelIdentifier);
            if (parsed) results.push(parsed);
            continue; 
          }

          // DELIVERY STATUS
          if (event.delivery) {
            for (const mid of event.delivery?.mids ?? []) {
              results.push({
                externalId: mid,
                contactIdentifier: event.sender?.id,
                direction: 'outgoing',
                messageType: 'status',
                status: 'delivered',
                attachments: [],
                raw: event
              } as any);
            }
            continue;
          }

          // READ STATUS
          if (event.read) {
            results.push({
              externalId: null, // Messenger doesn't give message id
              contactIdentifier: event.sender?.id,
              direction: 'outgoing',
              messageType: 'status_read',
              watermark: event.read?.watermark ?? event.timestamp, // Instagram doesn't have watermark but we can use timestamp to mark as read
              attachments: [],
              raw: event
            } as any);
          }

        
      }
    }

    return results;
  }

  private parseEvent(event: any,channelIdentifier: string): ParsedInbound | null {
    const senderId: string = event.sender?.id;
    const recipientId: string = event.recipient?.id;
    const isSentByPage = senderId === channelIdentifier;


    // Reaction
    if (event.reaction) {
      return {
        externalId: `${event.reaction.mid}_reaction_${senderId}`,
        contactIdentifier: senderId,
        recipientIdentifier: recipientId,
        direction: isSentByPage ? 'outgoing' : 'incoming', // Reactions can be sent by either party or even the system, but we'll assume it's outgoing if sent by the page
        messageType: 'reaction',
        // timestamp: event.timestamp,
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
    const story = msg.reply_to?.story ?? null;
    if (story) {
      this.logger.log(
        `Meta story reply parsed sender=${senderId} recipient=${recipientId} mid=${msg.mid ?? 'missing'} story=${story.id ?? story.story_id ?? story.url ?? 'unknown'}`,
      );
    }
    const storyReplyMeta = story
      ? {
          storyReply: {
            storyId: story.id ?? story.story_id ?? null,
            storyUrl: story.url ?? story.link ?? null,
          },
        }
      : undefined;

    const base = {
      externalId: msg.mid,
      contactIdentifier: senderId,
      direction: 'incoming' as const,
      replyToChannelMsgId: msg.reply_to?.mid,
      timestamp: event.timestamp,
      raw: event,
      metadata: storyReplyMeta,
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
        metadata: { ...storyReplyMeta, quickReply: msg.quick_reply },
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
      metadata: storyReplyMeta,
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
    const token = channel.credentials?.accessToken;
    const { data: meta } = await axios.get(`${FACEBOOKGRAPH}/${mediaId}`, {
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
      const GRAPH = channel.type === 'instagram' ? INSTAGRAPH : FACEBOOKGRAPH;
      const token = channel.credentials?.accessToken;
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
    const token = channel.credentials?.accessToken;
    const pageId = channel.identifier;
    const Chtype =  channel.type
    const GRAPH = Chtype === 'instagram' ? INSTAGRAPH : FACEBOOKGRAPH; // Instagram Graph API has a different base URL and slightly different behavior, so we switch based on channel type

    const body = {
      messaging_type: 'RESPONSE',
      ...payload,
    };

    console.dir({ body }, { depth: null });

    const { data } = await axios.post(
      `${GRAPH}/${pageId}/messages?access_token=${token}`,
      body,

    );
    console.dir({ SENDED_RESP: data }, { depth: null });

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
