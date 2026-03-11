// import { PrismaService } from 'prisma/prisma.service';
// import { ChannelProvider, DownloadResult, OutboundPayload, ParsedAttachment, ParsedMessage } from '../channel-provider.interface';
// import { Logger } from '@nestjs/common';
// const GRAPH_BASE = 'https://graph.facebook.com/v19.0';
// import axios from 'axios';

// export class InstagramProvider implements ChannelProvider {
//   type = 'instagram';
//   private readonly logger = new Logger(InstagramProvider.name);

//   constructor(private prisma: PrismaService) { }

//   async send(payload: OutboundPayload) {
//     const channel = await this.prisma.channel.findUnique({
//       where: { id: payload.channelId },
//     });

//     if (!channel) throw new Error('Channel not found');

//     const config = channel.config as any;

//     const res = await fetch(
//       `https://graph.facebook.com/v19.0/me/messages`,
//       {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           Authorization: `Bearer ${config.pageAccessToken}`,
//         },
//         body: JSON.stringify({
//           recipient: {
//             id: payload.to,
//           },
//           messaging_type: "RESPONSE",
//           message: {
//             text: payload.text,
//           },
//         }),
//       }
//     );

//     const data = await res.json();

//     if (!res.ok) throw new Error(JSON.stringify(data));

//     return { externalId: data.message_id };
//   }

//   // -------------------------------------------------------------------------
//   // parseWebhook
//   // -------------------------------------------------------------------------

//   async parseWebhook(body: any): Promise<ParsedMessage[]> {
//     const messages: ParsedMessage[] = [];

//     const entries: any[] = body?.entry ?? [];

//     for (const entry of entries) {
//       const messagingEvents: any[] = entry?.messaging ?? [];

//       for (const event of messagingEvents) {
//         // Ignore message delivery / read receipts
//         if (event.delivery || event.read) continue;

//         try {
//           const parsed = this.parseMessagingEvent(event);
//           if (parsed) messages.push(parsed);
//         } catch (err) {
//           this.logger.error(
//             `Failed parsing Instagram event: ${err.message}`,
//           );
//         }
//       }
//     }

//     return messages;
//   }

//   // -------------------------------------------------------------------------
//   // Single event parser
//   // -------------------------------------------------------------------------

//   private parseMessagingEvent(event: any): ParsedMessage | null {
//     const senderId: string = event.sender?.id;
//     const recipientId: string = event.recipient?.id;
//     const timestamp = new Date(event.timestamp);
//     const msg = event.message;

//     if (!msg) return null;

//     const attachments: ParsedAttachment[] = [];
//     let text: string | undefined = msg.text;

//     // ── Reaction ────────────────────────────────────────────────────────────
//     if (event.reaction) {
//       attachments.push({
//         type: 'reaction',
//         reactionEmoji: event.reaction.emoji,
//         reactionTargetMessageId: event.reaction.mid,
//       });
//       return {
//         externalId: event.reaction.mid + '_reaction',
//         from: senderId,
//         to: recipientId,
//         timestamp,
//         attachments,
//         rawPayload: event,
//         isDeleted: event.reaction.action === 'unreact',
//       };
//     }

//     // ── Deleted message ─────────────────────────────────────────────────────
//     if (msg.is_deleted) {
//       return {
//         externalId: msg.mid,
//         from: senderId,
//         to: recipientId,
//         timestamp,
//         attachments: [],
//         rawPayload: event,
//         isDeleted: true,
//       };
//     }

//     // ── Attachments ─────────────────────────────────────────────────────────
//     for (const att of msg.attachments ?? []) {
//       const parsed = this.parseAttachment(att);
//       if (parsed) attachments.push(parsed);
//     }

//     // ── Reply / reference ───────────────────────────────────────────────────
//     const replyTo: string | undefined = msg.reply_to?.mid;

//     return {
//       externalId: msg.mid,
//       from: senderId,
//       to: recipientId,
//       timestamp,
//       text,
//       attachments,
//       replyToExternalId: replyTo,
//       rawPayload: event,
//     };
//   }

//   // -------------------------------------------------------------------------
//   // Attachment parser
//   // -------------------------------------------------------------------------

//   private parseAttachment(att: any): ParsedAttachment | null {
//     const payload = att.payload ?? {};

//     switch (att.type) {
//       case 'image':
//         return {
//           type: 'image',
//           url: payload.url,
//           stickerId: payload.sticker_id?.toString(),
//           // Stickers come through as image type on Instagram
//           ...(payload.sticker_id ? { type: 'sticker' as any } : {}),
//         };

//       case 'video':
//         return {
//           type: 'video',
//           url: payload.url,
//         };

//       case 'audio':
//         return {
//           type: 'audio',
//           url: payload.url,
//         };

//       case 'file':
//         return {
//           type: 'document',
//           url: payload.url,
//           filename: payload.name,
//         };

//       // ── Story mention ──────────────────────────────────────────────────
//       case 'story_mention':
//         return {
//           type: 'story_mention',
//           url: payload.url,
//           thumbnailUrl: payload.thumbnail,
//         };

//       // ── Reel / IG TV share ─────────────────────────────────────────────
//       case 'reel':
//       case 'ig_reel':
//         return {
//           type: 'video',
//           url: payload.url,
//           thumbnailUrl: payload.thumbnail,
//           caption: payload.title,
//         };

//       // ── Shared post / product ──────────────────────────────────────────
//       case 'share':
//         return {
//           type: 'unsupported',
//           caption: `[Share] ${payload.link ?? ''}`,
//         };

//       case 'product_template':
//       case 'generic_template':
//         return {
//           type: 'unsupported',
//           caption: `[Template] ${att.type}`,
//         };

//       default:
//         this.logger.warn(`Unknown Instagram attachment type: ${att.type}`);
//         return { type: 'unsupported' };
//     }
//   }

//   // -------------------------------------------------------------------------
//   // downloadMedia — Instagram CDN requires Bearer token
//   // -------------------------------------------------------------------------

//   async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
//     const token = channel.credentials?.accessToken;
//     if (!token) throw new Error('Instagram channel missing accessToken');

//     // Get media URL from Graph API
//     const metaRes = await axios.get(`${GRAPH_BASE}/${mediaId}`, {
//       params: { fields: 'url,mime_type' },
//       headers: { Authorization: `Bearer ${token}` },
//     });

//     const mediaUrl: string = metaRes.data.url;
//     const mimeType: string = metaRes.data.mime_type ?? 'application/octet-stream';

//     const dlRes = await axios.get<ArrayBuffer>(mediaUrl, {
//       headers: { Authorization: `Bearer ${token}` },
//       responseType: 'arraybuffer',
//     });

//     return { buffer: dlRes.data, mimeType };
//   }
// }