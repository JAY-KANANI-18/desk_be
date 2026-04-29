// src/inbound/inbound.service.ts
//
// Called by ALL webhook controllers with a normalized InboundDto.
// Handles: contact upsert, conversation upsert, media processing,
//          message + attachments persistence, event emit.

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { ParsedAttachment } from '../channel-adapters/channel-adapter.interface';
import {
  isMissingOrStaticContactAvatarUrl,
  resolveContactAvatarUrl,
} from '../../common/contacts/static-contact-avatar';

// ─── DTO ─────────────────────────────────────────────────────────────────────
// This is what EVERY webhook controller passes to inbound.process()

export interface InboundDto {
  channelId: string;
  workspaceId: string;
  channelType: string;           // 'whatsapp' | 'instagram' | 'messenger' | 'email' | 'sms' | 'exotel_call' | 'meta_ads'

  contactIdentifier: string;     // phone / PSID / email address
  direction: 'incoming' | 'outgoing'; // from provider's POV

  // The normalized message type from provider.parseWebhook()
  messageType?: string;

  text?: string;
  subject?: string;

  attachments?: ParsedAttachment[];

  // For threaded replies
  replyToChannelMsgId?: string;
  channelMsgId?: string;
  timestamp?: string | number | null;

  // reaction, order, location, interactive, etc.
  metadata?: Record<string, any>;

  // Full raw provider payload
  raw?: any;

  // Contact profile fetched in the controller (if not already cached)
  profile?: { name?: string; avatarUrl?: string } | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(

    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly emitter: EventEmitter2,
  ) { }

  async process(dto: InboundDto): Promise<void> {
    const {
      channelId, workspaceId, channelType,
      contactIdentifier, direction,
      messageType, text, subject,
      attachments = [], replyToChannelMsgId, channelMsgId,
      metadata, raw, profile, timestamp,
    } = dto;

    // ── 1. Upsert Contact + ContactChannel ─────────────────────────────────
    const { contact, contactChannel } = await this.upsertContact({
      workspaceId, channelId, channelType, contactIdentifier, profile,
    });

    // ── 2. Upsert Conversation ─────────────────────────────────────────────
    const  conversation = await this.upsertConversation({
      workspaceId, channelId, channelType, contactId: contact.id, subject,
    });
    

    // ── 3. Process media attachments ───────────────────────────────────────
    const storedMedia = await this.media.processAttachments(
      channelId, workspaceId, attachments,
    );
    const quotedMessage = await this.resolveQuotedMessagePreview({
      workspaceId,
      channelId,
      replyToChannelMsgId,
    });
    const messageMetadata = this.buildMessageMetadata(
      metadata,
      contactChannel.identifier,
      quotedMessage,
    );

    // ── 4. Persist Message ─────────────────────────────────────────────────
    const message = await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        channelId,
        channelType,
        type: messageType ?? (attachments[0]?.type ?? 'text'),
        direction,
        text,
        subject,
        status: 'delivered',
        channelMsgId,
        replyToChannelMsgId,
        metadata: messageMetadata,
        rawPayload: raw ?? undefined,
        sentAt: new Date(),
      },
      include: {
        channel: true,
        author:true
      }
    },

    );

    // ── 5. Persist MessageAttachments ──────────────────────────────────────
    if (attachments.length > 0) {
      await this.prisma.messageAttachment.createMany({
        data: attachments.map((att, i) => ({
          messageId: message.id,
          type: att.type,
          name: storedMedia[i]?.filename ?? att.filename ?? null,
          mimeType: storedMedia[i]?.mimeType ?? att.mimeType ?? null,
          size: storedMedia[i]?.size ?? att.size ?? null,
          url: storedMedia[i]?.url || att.url || '',
          assetId: storedMedia[i]?.assetId ?? null,
          metadata: this.buildAttachmentMeta(att),
        })),
      });
    }

    // ── 6. Update Conversation lastMessage + unreadCount ───────────────────
    await this.updateContactChannelWindow({
      contactChannelId: contactChannel.id,
      channelType,
      eventTimestamp: timestamp,
      metadata,
      raw,
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageId: message.id,
        lastMessageAt: new Date(),
        lastIncomingAt: new Date(),
        unreadCount: { increment: 1 },
      },
    });

    // ── 7. Emit for downstream (AI, notifications, websocket) ──────────────
    this.emitter.emit('message.inbound', {
      workspaceId,
      conversationId: conversation.id,
      message
    });

    this.logger.log(`Inbound OK conv=${conversation.id} msg=${message.id} type=${message.type} attachments=${attachments.length}`);
  }

  // ─── Contact upsert ────────────────────────────────────────────────────────

  private async upsertContact(opts: {
    workspaceId: string;
    channelId: string;
    channelType: string;
    contactIdentifier: string;
    profile?: { name?: string; avatarUrl?: string } | null;
  }) {
    const { workspaceId, channelId, channelType, contactIdentifier, profile } = opts;

    // Find existing ContactChannel
    let contactChannel = await this.prisma.contactChannel.findFirst({
      where: { workspaceId, channelId, identifier: contactIdentifier },
      include: { contact: true },
    });

    if (contactChannel) {
      // Update profile if we got fresh data
      if (profile?.name || profile?.avatarUrl) {
        await this.prisma.contactChannel.update({
          where: { id: contactChannel.id },
          data: {
            displayName: profile.name ?? contactChannel.displayName,
            avatarUrl: profile.avatarUrl ?? contactChannel.avatarUrl,
          },
        });
        if (
          profile.avatarUrl &&
          isMissingOrStaticContactAvatarUrl(contactChannel.contact.avatarUrl)
        ) {
          await this.prisma.contact.update({
            where: { id: contactChannel.contact.id },
            data: { avatarUrl: profile.avatarUrl },
          });
        }
      }

      // Keep phone/email backfilled for channels where identifier is the real customer phone/email.
      if (channelType === 'sms' || channelType === 'exotel_call' || channelType === 'whatsapp') {
        if (!contactChannel.contact.phone) {
          await this.prisma.contact.update({
            where: { id: contactChannel.contact.id },
            data: { phone: contactIdentifier },
          });
        }
      }
      if (channelType === 'email' && !contactChannel.contact.email) {
        await this.prisma.contact.update({
          where: { id: contactChannel.contact.id },
          data: { email: contactIdentifier },
        });
      }

      // ── Reopen contact if they were closed and sent a new message ──────
      if (contactChannel.contact.status === 'closed') {
        await this.prisma.contact.update({
          where: { id: contactChannel.contact.id },
          data: { status: 'open' },
        });

        // Refresh contact object
        contactChannel.contact.status = 'open';

        // Emit for workflow engine — conversation_opened trigger
        this.emitter.emit('conversation.opened', {
          workspaceId,
          contactId: contactChannel.contact.id,
          conversationId: null,   // filled after upsertConversation
          source: 'contact',
          channel: channelType,
        });
      }

      return { contact: contactChannel.contact, contactChannel };
    }

    // No existing — derive name from identifier or profile
    const nameParts = this.deriveName(contactIdentifier, channelType, profile);

    // Create Contact
    const contact = await this.prisma.contact.create({
      data: {
        workspaceId,
        firstName: nameParts.firstName,
        lastName: nameParts.lastName,
        email: channelType === 'email' ? contactIdentifier : undefined,
        phone: ['whatsapp', 'sms', 'exotel_call'].includes(channelType) ? contactIdentifier : undefined,
        avatarUrl: resolveContactAvatarUrl(profile?.avatarUrl),
        status: 'open',   // ← new contact starts as open
      },
    });

    // Create ContactChannel
    contactChannel = await this.prisma.contactChannel.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channelId,
        channelType,
        identifier: contactIdentifier,
        displayName: profile?.name,
        avatarUrl: profile?.avatarUrl,
      },
      include: { contact: true },
    });

    this.emitter.emit('conversation.opened', {
          workspaceId,
          contactId: contactChannel.contact.id,
          conversationId: null,   // filled after upsertConversation
          source: 'contact',
          channel: channelType,
        });
    return { contact, contactChannel };
  }

  // ─── Conversation upsert ───────────────────────────────────────────────────
  private async upsertConversation(opts: {
    workspaceId: string;
    channelId: string;
    channelType: string;
    contactId: string;
    subject?: string;
  }) {
    const { workspaceId, channelId, channelType, contactId, subject } = opts;

    // For email, thread by subject. For others, find latest open conversation.
    const existing = await this.prisma.conversation.findFirst({
      where: {
        workspaceId,
        contactId,
        // Email: same subject = same thread
        ...(subject ? { subject } : {}),
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
        subject,
        status: 'open',
      },
    });
  }
  // ─── Helpers ──────────────────────────────────────────────────────────────

  private deriveName(
    identifier: string,
    channelType: string,
    profile?: { name?: string } | null,
  ): { firstName: string; lastName?: string } {
    if (profile?.name) {
      const parts = profile.name.trim().split(' ');
      return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined };
    }
    if (channelType === 'email') {
      return { firstName: identifier.split('@')[0] };
    }
    return { firstName: identifier };
  }

  private buildAttachmentMeta(att: ParsedAttachment): any {
    const meta: any = {};
    if (att.caption) meta.caption = att.caption;
    if (att.duration) meta.duration = att.duration;
    if (att.width) meta.width = att.width;
    if (att.height) meta.height = att.height;
    if (att.latitude != null) meta.lat = att.latitude;
    if (att.longitude != null) meta.lng = att.longitude;
    if (att.locationName) meta.locationName = att.locationName;
    if (att.locationAddress) meta.locationAddress = att.locationAddress;
    if (att.contactVcard) meta.vcard = att.contactVcard;
    if (att.reactionEmoji) meta.emoji = att.reactionEmoji;
    if (att.reactionTargetMsgId) meta.targetMsgId = att.reactionTargetMsgId;
    if (att.stickerId) meta.stickerId = att.stickerId;
    if (att.thumbnailUrl) meta.thumbnailUrl = att.thumbnailUrl;
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  private async resolveQuotedMessagePreview(opts: {
    workspaceId: string;
    channelId: string;
    replyToChannelMsgId?: string;
  }) {
    const { workspaceId, channelId, replyToChannelMsgId } = opts;
    if (!replyToChannelMsgId) return undefined;

    const target = await this.prisma.message.findFirst({
      where: {
        workspaceId,
        channelId,
        channelMsgId: replyToChannelMsgId,
      },
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

    if (!target) return undefined;

    const attachment = target.messageAttachments[0];
    return {
      id: target.id,
      text: target.text ?? undefined,
      author: this.getQuotedAuthorLabel(target),
      attachmentType: this.normaliseQuotedAttachmentType(attachment?.type),
      attachmentUrl: attachment?.url ?? undefined,
    };
  }

  private buildMessageMetadata(
    metadata: Record<string, any> | undefined,
    contactIdentifier: string,
    quotedMessage?: {
      id: string;
      text?: string;
      author: string;
      attachmentType?: string;
      attachmentUrl?: string;
    },
  ) {
    const next: Record<string, any> = {
      ...(metadata ?? {}),
      contactIdentifier,
    };
    if (quotedMessage) next.quotedMessage = quotedMessage;
    return Object.keys(next).length > 0 ? next : undefined;
  }

  private getQuotedAuthorLabel(message: {
    direction: string;
    author?: { firstName?: string | null; lastName?: string | null } | null;
    conversation?: {
      contact?: {
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        phone?: string | null;
      } | null;
    } | null;
  }) {
    if (message.direction === 'outgoing') {
      const fullName = [message.author?.firstName, message.author?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      return fullName || 'You';
    }

    const contact = message.conversation?.contact;
    const fullName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
    return fullName || contact?.email || contact?.phone || 'Customer';
  }

  private normaliseQuotedAttachmentType(type?: string) {
    if (!type) return undefined;
    if (type === 'voice') return 'audio';
    if (type === 'image' || type === 'video' || type === 'audio') return type;
    return 'file';
  }

  private async updateContactChannelWindow(opts: {
    contactChannelId: string;
    channelType: string;
    eventTimestamp?: string | number | null;
    metadata?: Record<string, any>;
    raw?: any;
  }) {
    const eventTimeMs = this.toEpochMs(opts.eventTimestamp) ?? Date.now();
    const explicitExpiry =
      this.toEpochMs(opts.metadata?.messageWindowExpiry) ??
      this.toEpochMs(opts.metadata?.conversation?.expiration_timestamp) ??
      this.toEpochMs(opts.raw?.status?.conversation?.expiration_timestamp);
    const inferredExpiry = this.inferWindowExpiry(opts.channelType, eventTimeMs);
    const nextWindowCategory =
      this.extractConversationWindowCategory(opts.metadata) ??
      this.extractConversationWindowCategory(opts.raw?.status);
    const nextCallPermission = this.extractNullableBoolean(
      opts.metadata?.call_permission ?? opts.raw?.call_permission,
    );
    const nextPermanentCallPermission = this.extractBoolean(
      opts.metadata?.hasPermanentCallPermission ?? opts.raw?.hasPermanentCallPermission,
    );

    await this.prisma.contactChannel.update({
      where: { id: opts.contactChannelId },
      data: {
        lastMessageTime: BigInt(Math.trunc(eventTimeMs)),
        lastIncomingMessageTime: BigInt(Math.trunc(eventTimeMs)),
        ...(explicitExpiry || inferredExpiry
          ? { messageWindowExpiry: BigInt(Math.trunc(explicitExpiry ?? inferredExpiry!)) }
          : {}),
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

  private inferWindowExpiry(channelType: string, eventTimeMs: number): number | null {
    const duration = this.windowDurationMs(channelType);
    if (!duration) return null;
    return eventTimeMs + duration;
  }

  private windowDurationMs(channelType: string): number | null {
    switch (channelType) {
      case 'whatsapp':
      case 'messenger':
        return 24 * 60 * 60 * 1000;
      case 'instagram':
        return 7 * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
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
}
