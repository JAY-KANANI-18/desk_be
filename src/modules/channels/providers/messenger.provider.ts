// import { PrismaService } from 'prisma/prisma.service';
// import { ChannelProvider, DownloadResult, OutboundPayload, ParsedAttachment, ParsedMessage } from '../channel-provider.interface';
// import axios from 'axios';
// import { Logger } from '@nestjs/common';
// const GRAPH_BASE = 'https://graph.facebook.com/v19.0';


// export class MessengerProvider implements ChannelProvider {
//   type = 'messenger';
//   private readonly logger = new Logger(MessengerProvider.name);

//   constructor(private prisma: PrismaService) { }

//   async send(payload: OutboundPayload) {
//     const channel = await this.prisma.channel.findUnique({
//       where: { id: payload.channelId },
//     });

//     if (!channel) throw new Error('Channel not found');

//     const config = channel.config as any;
//     console.log('MessengerProvider send', { payload, config });
//     const res = await fetch(
//       `https://graph.facebook.com/v19.0/me/messages`,
//       {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           Authorization: `Bearer ${config.accessToken}`, //config.pageAccessToken
//         },
//         body: JSON.stringify({
//           recipient: { id: payload.to },
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
//         // Ignore delivery / read receipts
//         if (event.delivery || event.read) continue;

//         try {
//           const parsed = this.parseMessagingEvent(event);
//           if (parsed) messages.push(parsed);
//         } catch (err) {
//           this.logger.error(
//             `Failed parsing Messenger event: ${err.message}`,
//           );
//         }
//       }
//     }

//     return messages;
//   }

//   // -------------------------------------------------------------------------
//   // Single event
//   // -------------------------------------------------------------------------

//   private parseMessagingEvent(event: any): ParsedMessage | null {
//     const senderId: string = event.sender?.id;
//     const recipientId: string = event.recipient?.id;
//     const timestamp = new Date(event.timestamp);

//     // ── Postback (button tap) ───────────────────────────────────────────────
//     if (event.postback) {
//       return {
//         externalId: `${senderId}_${event.timestamp}_postback`,
//         from: senderId,
//         to: recipientId,
//         timestamp,
//         text: event.postback.title ?? event.postback.payload,
//         attachments: [],
//         rawPayload: event,
//       };
//     }

//     // ── Reaction ────────────────────────────────────────────────────────────
//     if (event.reaction) {
//       return {
//         externalId: `${event.reaction.mid}_reaction`,
//         from: senderId,
//         to: recipientId,
//         timestamp,
//         attachments: [
//           {
//             type: 'reaction',
//             reactionEmoji: event.reaction.emoji,
//             reactionTargetMessageId: event.reaction.mid,
//           },
//         ],
//         rawPayload: event,
//         isDeleted: event.reaction.action === 'unreact',
//       };
//     }

//     const msg = event.message;
//     if (!msg) return null;

//     const attachments: ParsedAttachment[] = [];
//     let text: string | undefined = msg.text;

//     // ── Quick reply ─────────────────────────────────────────────────────────
//     if (msg.quick_reply) {
//       text = msg.text ?? msg.quick_reply.payload;
//     }

//     // ── Attachments ─────────────────────────────────────────────────────────
//     for (const att of msg.attachments ?? []) {
//       const parsed = this.parseAttachment(att);
//       if (parsed) attachments.push(parsed);
//     }

//     // ── NLP / referral extras ───────────────────────────────────────────────
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
//       isDeleted: msg.is_deleted ?? false,
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
//           type: payload.sticker_id ? 'sticker' : 'image',
//           url: payload.url,
//           stickerId: payload.sticker_id?.toString(),
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

//       case 'location':
//         return {
//           type: 'location',
//           latitude: payload.coordinates?.lat,
//           longitude: payload.coordinates?.long,
//           locationName: payload.title,
//         };

//       // ── Templates ─────────────────────────────────────────────────────────
//       case 'template': {
//         const tplType = payload.template_type;
//         switch (tplType) {
//           case 'generic':
//           case 'button':
//           case 'media':
//             return {
//               type: 'unsupported',
//               caption: `[Template:${tplType}] ${payload.elements?.[0]?.title ?? ''}`,
//             };
//           case 'receipt':
//             return {
//               type: 'unsupported',
//               caption: `[Receipt] order_number=${payload.order_number}`,
//             };
//           default:
//             return { type: 'unsupported', caption: `[Template:${tplType}]` };
//         }
//       }

//       // ── Fallback ───────────────────────────────────────────────────────────
//       default:
//         this.logger.warn(`Unknown Messenger attachment type: ${att.type}`);
//         return { type: 'unsupported' };
//     }
//   }

//   // -------------------------------------------------------------------------
//   // downloadMedia — Messenger CDN is mostly public but may need page token
//   //   for older content; we always attempt direct fetch first.
//   // -------------------------------------------------------------------------

//   async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
//     const token = channel.credentials?.accessToken;
//     if (!token) throw new Error('Messenger channel missing accessToken');

//     const metaRes = await axios.get(`${GRAPH_BASE}/${mediaId}`, {
//       params: { fields: 'url,mime_type' },
//       headers: { Authorization: `Bearer ${token}` },
//     });

//     const mediaUrl: string = metaRes.data.url;
//     const mimeType: string = metaRes.data.mime_type ?? 'application/octet-stream';

//     const dlRes = await axios.get<ArrayBuffer>(mediaUrl, {
//       responseType: 'arraybuffer',
//     });

//     return { buffer: dlRes.data, mimeType };
//   }

//   async getContactProfile(psid: string, channelId: string) {
//   const channel = await this.prisma.channel.findUnique({
//     where: { id: channelId },
//   });

//   const config = channel?.config as any;

//   const res = await fetch(
//     `https://graph.facebook.com/${psid}?fields=first_name,last_name,profile_pic&access_token=${config.accessToken}`
//   );

//   const data = await res.json();

//   return {
//     firstName: data.first_name,
//     lastName: data.last_name,
//     avatarUrl: data.profile_pic,
//   };
// }
// }