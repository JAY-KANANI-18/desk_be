// src/inbound/inbound.service.ts
//
// Called by ALL webhook controllers with a normalized InboundDto.
// Handles: contact upsert, conversation upsert, media processing,
//          message + attachments persistence, event emit.

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { ParsedAttachment } from '../channel-adapters/channel-adapter.interface';

// ─── DTO ─────────────────────────────────────────────────────────────────────
// This is what EVERY webhook controller passes to inbound.process()

export interface InboundDto {
  channelId: string;
  workspaceId: string;
  channelType: string;           // 'whatsapp' | 'instagram' | 'messenger' | 'email'

  contactIdentifier: string;     // phone / PSID / email address
  direction: 'incoming' | 'outgoing'; // from provider's POV

  // The normalized message type from provider.parseWebhook()
  messageType?: string;

  text?: string;
  subject?: string;

  attachments?: ParsedAttachment[];

  // For threaded replies
  replyToChannelMsgId?: string;

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
      attachments = [], replyToChannelMsgId,
      metadata, raw, profile,
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
        replyToChannelMsgId,
        metadata: metadata ? { ...metadata, contactIdentifier: contactChannel.identifier } : undefined,
        rawPayload: raw ?? undefined,
        sentAt: new Date(),
      },
      include: {
        channel: true
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
        if (profile.avatarUrl && !contactChannel.contact.avatarUrl) {
          await this.prisma.contact.update({
            where: { id: contactChannel.contact.id },
            data: { avatarUrl: profile.avatarUrl },
          });
        }
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
        phone: channelType === 'whatsapp' ? contactIdentifier : undefined,
        avatarUrl: profile?.avatarUrl,
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
}