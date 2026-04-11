// src/conversations/conversations.service.ts
//
// Complete ConversationService.
// Covers:
//   findAll()       — filter + search + cursor pagination
//   searchMessages()— full-text across message.text
//   findOne()       — single conversation
//   create()        — new conversation
//   getTimeline()   — paginated messages + activities merged
//   getMessages()   — paginated messages only
//   sendMessage()   — create outbound message + queue
//   sendNote()      — delegates to ActivityService
//   markRead()      — zero unread count
//   updateStatus()
//   assignUser() / unassignUser()
//   assignTeam() / unassignTeam()
//   changePriority()
//   mergeContact()
//   recordChannelAdded()

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AssignUserActivityMeta,
  AssignTeamActivityMeta,
  UnassignUserActivityMeta,
  UnassignTeamActivityMeta,
  MergeContactActivityMeta,
  ChannelAddedActivityMeta,
  OpenActivityMeta,
  CloseActivityMeta,
} from '../activity/activity.types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MentionParserService } from './mention-parser.service';

// ─── DTOs ─────────────────────────────────────────────────────────────────────


export interface FindAllOptions {
  workspaceId: string;
  status?: string;
  priority?: string;
  direction?: 'incoming' | 'outgoing' | 'all';
  channelType?: string;
  /** uuid | 'me' | 'unassigned' */
  assigneeId?: string;
  teamId?: string;
  unreplied?: boolean;
  /** Contact name / email / phone search */
  search?: string;
  cursor?: string;
  limit?: number;
  lifecycleId?: string;
  /** Resolved from jwt in controller */
  actorUserId?: string;
}

export interface SendMessageDto {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  actorId: string;
  text?: string;
  attachments?: Array<{
    type: string;
    url: string;
    name: string;
    mimeType?: string;
  }>;
  metadata?: Record<string, any>;
}

export interface AssignUserDto {
  userId: string;
  teamId?: string;
  actorId?: string;
}

export interface UnassignUserDto { actorId?: string; }

export interface AssignTeamDto {
  teamId: string;
  actorId?: string;
}

export interface UnassignTeamDto { actorId?: string; }

export interface MergeContactDto {
  mergedContactId: string;
  actorId?: string;
}

export interface AddNoteDto {
  text: string;
  actorId: string;
  mentionedUserIds?: string[];
}

export interface ChangePriorityDto {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  actorId?: string;
}

export interface UpdateStatusDto {
  status: 'open' | 'pending' | 'resolved' | 'closed';
  actorId?: string;
  actorType?: 'user' | 'system' | 'automation';
}

// ─── Prisma select for conversation list items ────────────────────────────────
// Shared across findAll / findOne so shapes are consistent.

const CONV_INCLUDE = {
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      avatarUrl: true,
      company: true,
      status: true,
      assigneeId: true,
      teamId: true,
      lifecycleId: true,
      contactChannels: {
        select: {
          channelId: true,
          channelType: true
        }
      }
    },
  },

  lastMessage: {
    select: {
      id: true,
      text: true,
      direction: true,
      type: true,
      status: true,
      createdAt: true,
      channelId: true,
      channel: true
    },
  },
} satisfies Prisma.ConversationInclude;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly emitter: EventEmitter2,
    private readonly notifications: NotificationsService,
    private readonly mentionParser: MentionParserService,
  ) { }

  // ═══════════════════════════════════════════════════════════════════════════
  // READ
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List conversations with full filter + search + cursor pagination.
   * Returns { data, nextCursor, total }.
   */
  async findAll(workspaceId: string, opts: Omit<FindAllOptions, 'workspaceId'> = {}) {
    const {
      status,
      priority,
      direction,
      channelType,
      assigneeId,
      teamId,
      unreplied = false,
      search,
      cursor,
      limit = 25,
      actorUserId,
      lifecycleId,
    } = opts;

    const take = Math.min(limit, 100);
    console.log({workspaceId});

    // ── Build where clause ────────────────────────────────────────────────────
    const where: Prisma.ConversationWhereInput = { workspaceId };

    if (status && status !== 'all') {
      where.status = status;
    }

    if (priority && priority !== 'all') {
      where.priority = priority;
    }

    // if (channelType && channelType !== 'all') {
    //   where.channelType = channelType;
    // }

    if (direction && direction !== ('all' as any)) {
      where.lastMessage = { direction };
    }

    // unreplied = last message is incoming (customer waiting)
    if (unreplied) {
      where.lastMessage = { direction: 'incoming' };
    }

    // Assignee filter
    if (assigneeId) {
      if (assigneeId === 'unassigned') {
        where.contact = { assigneeId: null };
      } else if (assigneeId === 'me' && actorUserId) {
        where.contact = { assigneeId: actorUserId };
      } else {
        // specific UUID
        where.contact = { assigneeId };
      }
    }
    if (lifecycleId) {
      where.contact = { lifecycleId };
    }

    if (teamId) {
      where.contact = { ...(where.contact as any), teamId };
    }

    // Search by contact name / email / phone
    if (search?.trim()) {
      const q = search.trim();
      where.contact = {
        ...(where.contact as any),
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
        ],
      };
    }

    // ── Cursor pagination ─────────────────────────────────────────────────────
    const [total, rows] = await Promise.all([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.findMany({
        where,
        include: CONV_INCLUDE,
        orderBy: { lastMessageAt: 'desc' },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    ]);

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : undefined;

    return { data, nextCursor, total };
  }

  /**
   * Full-text search across message text.
   * Returns matched snippets with conversation + contact context.
   */
  async searchMessages(workspaceId: string, q: string, limit = 20) {
    if (!q?.trim()) return [];

    const messages = await this.prisma.message.findMany({
      where: {
        workspaceId,
        text: { contains: q.trim(), mode: 'insensitive' },
        type: { not: 'activity' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        conversation: {
          include: {
            contact: {
              select: {
                id: true, firstName: true, lastName: true,
                email: true, phone: true, avatarUrl: true,
              },
            },
          },
        },
      },
    });

    return messages.map(m => ({
      conversationId: m.conversationId,
      messageId: m.id,
      text: m.text ?? '',
      snippet: this.buildSnippet(m.text ?? '', q.trim()),
      createdAt: m.createdAt.toISOString(),
      contact: m.conversation.contact,
    }));
  }

  /** Single conversation with full include */
  async findOne(id: string, workspaceId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: CONV_INCLUDE,
    });
    if (!conv) throw new NotFoundException(`Conversation ${id} not found`);
    return conv;
  }

  /** Create a new conversation (outbound-initiated) */
  async create(workspaceId: string, contactId: string, channelId?: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) throw new NotFoundException(`Contact ${contactId} not found`);

    const conv = await this.prisma.conversation.create({
      data: {
        workspaceId,
        contactId,

        status: 'open',
        priority: 'normal',
      },
      include: CONV_INCLUDE,
    });

    // Record open activity
    await this.activity.record({
      workspaceId,
      conversationId: conv.id,
      eventType: 'open',
      actorType: 'user',
      metadata: { previousStatus: null } satisfies OpenActivityMeta,
    });

    this.emitter.emit('conversation.created', conv);

    return conv;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMELINE + MESSAGES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Paginated timeline: messages + activities merged, sorted oldest-first.
   * Returns { data: TimelineItem[], nextCursor? }
   * cursor = id of the OLDEST item currently loaded (we load items older than it)
   */
  async getTimeline(
    conversationId: string,
    workspaceId: string,
    cursor?: string,
    limit = 30,
  ) {
    const take = Math.min(limit, 100);
    

    // Resolve cursor timestamp if provided
    let cursorDate: Date | undefined;
    if (cursor) {
      // Cursor encodes ISO timestamp; we fetch items BEFORE it
      try {
        cursorDate = new Date(Buffer.from(cursor, 'base64').toString('utf8'));
      } catch {
        cursorDate = undefined;
      }
    }

    const dateFilter = cursorDate ? { lt: cursorDate } : undefined;

    const [messages, activities] = await Promise.all([
      this.prisma.message.findMany({
        where: {
          conversationId,
          workspaceId,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: {
          author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          messageAttachments: true,
        },
      }),
      this.prisma.conversationActivity.findMany({
        where: {
          conversationId,
          workspaceId,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: {
          actor: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          subjectUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          subjectTeam: { select: { id: true, name: true } },
        },
      }),
    ]);
    const enrichedMessages = await this.enrichMessagesWithReplyContext(messages);

    // Merge + sort newest-first, take + 1 to detect more
    const allItems: Array<{ timestamp: Date; raw: any; type: 'message' | 'activity' }> = [
      ...enrichedMessages.map(m => ({
        type: 'message' as const,
        timestamp: m.sentAt ?? m.createdAt,
        raw: m,
      })),
      ...activities.map(a => ({
        type: 'activity' as const,
        timestamp: a.createdAt,
        raw: a,
      })),
    ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const hasMore = allItems.length > take;
    const page = allItems.slice(0, take);

    // Build timeline items
    const data = page.map(item => {
      if (item.type === 'message') {
        const m = item.raw;
        return {
          id: m.id,
          type: 'message' as const,
          timestamp: item.timestamp.toISOString(),
          message: this.formatMessage(m),
        };
      } else {
        return {
          id: item.raw.id,
          type: 'activity' as const,
          timestamp: item.timestamp.toISOString(),
          activity: this.activity.toResponsePublic(item.raw),
        };
      }
    });

    const nextCursor = hasMore
      ? Buffer.from(page[page.length - 1].timestamp.toISOString()).toString('base64')
      : undefined;

    return { data, nextCursor };
  }

  /**
   * Messages only, cursor-paginated (newest-first from BE; FE reverses for display).
   */
  async getMessages(
    conversationId: string,
    workspaceId: string,
    cursor?: string,
    limit = 30,
  ) {
    const take = Math.min(limit, 100);

    let cursorDate: Date | undefined;
    if (cursor) {
      try {
        cursorDate = new Date(Buffer.from(cursor, 'base64').toString('utf8'));
      } catch { }
    }

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        workspaceId,
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        messageAttachments: true,
      },
    });
    const enrichedMessages = await this.enrichMessagesWithReplyContext(messages);

    const hasMore = enrichedMessages.length > take;
    const data = enrichedMessages.slice(0, take).map(m => this.formatMessage(m));
    const nextCursor = hasMore
      ? Buffer.from(messages[take - 1].createdAt.toISOString()).toString('base64')
      : undefined;

    return { data, nextCursor };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates an outbound message record and adds it to the OutboundQueue.
   * The OutboundProcessor (separate job) picks it up and calls the provider.
   */
  async sendMessage(dto: SendMessageDto) {
    const conv = await this.findOrFail(dto.conversationId, dto.workspaceId);

    const channel = await this.prisma.channel.findFirst({
      where: { id: dto.channelId, workspaceId: dto.workspaceId },
    });
    if (!channel) throw new NotFoundException(`Channel ${dto.channelId} not found`);

    // Resolve `to` from ContactChannel
    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { contactId: conv.contactId, channelId: dto.channelId },
    });
    const to = contactChannel?.identifier;
    if (!to) {
      throw new BadRequestException(
        `No ContactChannel found for contact ${conv.contactId} on channel ${dto.channelId}. ` +
        `Cannot send — contact has never messaged on this channel.`,
      );
    }

    // Create Message row
    const message = await this.prisma.message.create({
      data: {
        workspaceId: dto.workspaceId,
        conversationId: dto.conversationId,
        channelId: dto.channelId,
        channelType: channel.type,
        type: dto.attachments?.length
          ? dto.attachments[0].type
          : 'text',
        direction: 'outgoing',
        text: dto.text ?? null,
        status: 'pending',
        authorId: dto.actorId,
        metadata: dto.metadata ? (dto.metadata as any) : undefined,
        sentAt: new Date(),
      },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        messageAttachments: true,
        channel: true,
      },
    });

    // Persist attachments
    if (dto.attachments?.length) {
      await this.prisma.messageAttachment.createMany({
        data: dto.attachments.map(a => ({
          messageId: message.id,
          type: a.type,
          name: a.name,
          mimeType: a.mimeType ?? null,
          url: a.url,
        })),
      });
    }

    // Update conversation last message
    await this.prisma.conversation.update({
      where: { id: dto.conversationId },
      data: {
        lastMessageId: message.id,
        lastMessageAt: new Date(),
      },
    });

    // Enqueue for delivery
    const payload = this.buildQueuePayload(channel.type, to, dto);
    await this.prisma.outboundQueue.create({
      data: {
        workspaceId: dto.workspaceId,
        channelId: dto.channelId,
        messageId: message.id,
        to,
        payload,
        status: 'pending',
      },
    });

    // Emit for real-time FE delivery
    this.emitter.emit('message.outbound', {
      workspaceId: dto.workspaceId,
      conversationId: dto.conversationId,
      message: this.formatMessage(message),
    });

    return this.formatMessage(message);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MARK READ
  // ═══════════════════════════════════════════════════════════════════════════

  async markRead(conversationId: string, workspaceId: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, workspaceId },
      data: { unreadCount: 0 },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE MUTATIONS  (unchanged from before, kept here for single-file clarity)
  // ═══════════════════════════════════════════════════════════════════════════

  async updateStatus(conversationId: string, dto: UpdateStatusDto) {
    const conv = await this.findOrFail(conversationId);

    const previousStatus = conv?.contact?.status;
    if (previousStatus === dto.status) return conv;

    const eventType = this.statusToEvent(previousStatus, dto.status);

  
    const updated = await this.prisma.contact.update({
      where: { id: conv.contactId },
      data: {
        
        status: dto.status,
  
      },
    });
    if (dto.status === 'closed') {

      this.emitter.emit('conversation.closed', {
        workspaceId: updated.workspaceId,
        contactId: updated.id,
        source: 'user'

      });
    } else  {
      this.emitter.emit('conversation.opened', {
        workspaceId: updated.workspaceId,
        contactId: updated.id,
        source: 'user'
      });
    }

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType,
      actorId: dto.actorId,
      actorType: dto.actorType ?? (dto.actorId ? 'user' : 'system'),
      metadata: { previousStatus } satisfies OpenActivityMeta | CloseActivityMeta,
    });
    const convUpdated = await this.findOrFail(conv.id);
    this.emitter.emit('conversation.updated', { ...convUpdated, workspaceId: conv.workspaceId });

    return updated;
  }

  async assignUser(conversationId: string, dto: AssignUserDto) {
    const conv = await this.findOrFail(conversationId);

    const contact = await this.prisma.contact.findUnique({
      where: { id: conv.contactId },
      select: {
        assigneeId: true,
        assignee: { select: { firstName: true, lastName: true } },
        teamId: true,
        team: { select: { name: true } },
      },
    });

    const newUser = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { firstName: true, lastName: true },
    });
    if (!newUser) throw new BadRequestException(`User ${dto.userId} not found`);

    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data: {
        assigneeId: dto.userId,
        teamId: dto.teamId ?? contact?.teamId ?? undefined,
      },
    });

    const meta: AssignUserActivityMeta = {
      previousUserId: contact?.assigneeId ?? null,
      previousUserName: contact?.assignee
        ? `${contact.assignee.firstName ?? ''} ${contact.assignee.lastName ?? ''}`.trim()
        : null,
      newUserId: dto.userId,
      newUserName: `${newUser.firstName ?? ''} ${newUser.lastName ?? ''}`.trim(),
    };

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'assign_user',
      actorId: dto.actorId,
      subjectUserId: dto.userId,
      subjectTeamId: dto.teamId,
      metadata: meta,
    });

    if (dto.teamId && dto.teamId !== contact?.teamId) {
      const newTeam = await this.prisma.team.findUnique({
        where: { id: dto.teamId }, select: { name: true },
      });
      const meta2: AssignTeamActivityMeta = {
        previousTeamId: contact?.teamId ?? null,
        previousTeamName: contact?.team?.name ?? null,
        newTeamId: dto.teamId,
        newTeamName: newTeam?.name ?? 'Unknown',
      };
      await this.activity.record({
        workspaceId: conv.workspaceId,
        conversationId: conv.id,
        eventType: 'assign_team',
        actorId: dto.actorId,
        subjectTeamId: dto.teamId,
        metadata: meta2,
      });
    }

    if (dto.userId !== dto.actorId) {
      const contactName = this.getContactDisplayName(conv.contact);
      await this.notifications.ingest({
        userId: dto.userId,
        workspaceId: conv.workspaceId,
        type: NotificationType.CONTACT_ASSIGNED,
        title: 'Contact assigned to you',
        body: `${contactName} was assigned to you.`,
        metadata: {
          contactId: conv.contactId,
          conversationId: conv.id,
          assignedByUserId: dto.actorId ?? null,
        },
        sourceEntityType: 'contact',
        sourceEntityId: conv.contactId,
        dedupeKey: `contact-assigned:${conv.contactId}:${dto.userId}`,
        target: {
          assigneeId: dto.userId,
          contactId: conv.contactId,
          conversationId: conv.id,
        },
      });
    }

    const updated = await this.findOne(conv.id, conv.workspaceId);
    this.emitter.emit('conversation.updated', updated);
    return updated;
  }

  async unassignUser(conversationId: string, dto: UnassignUserDto) {
    const conv = await this.findOrFail(conversationId);

    const contact = await this.prisma.contact.findUnique({
      where: { id: conv.contactId },
      select: {
        assigneeId: true,
        assignee: { select: { firstName: true, lastName: true } },
      },
    });

    if (!contact?.assigneeId) return;

    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data: { assigneeId: null },
    });

    const meta: UnassignUserActivityMeta = {
      previousUserId: contact.assigneeId,
      previousUserName: contact.assignee
        ? `${contact.assignee.firstName ?? ''} ${contact.assignee.lastName ?? ''}`.trim()
        : 'Unknown',
    };

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'unassign_user',
      actorId: dto.actorId,
      subjectUserId: contact.assigneeId,
      metadata: meta,
    });

    const updated = await this.findOne(conv.id, conv.workspaceId);
    this.emitter.emit('conversation.updated', updated);
    return updated;
  }

  async assignTeam(conversationId: string, dto: AssignTeamDto) {
    const conv = await this.findOrFail(conversationId);

    const contact = await this.prisma.contact.findUnique({
      where: { id: conv.contactId },
      select: { teamId: true, team: { select: { name: true } } },
    });

    const newTeam = await this.prisma.team.findUnique({
      where: { id: dto.teamId }, select: { name: true },
    });
    if (!newTeam) throw new BadRequestException(`Team ${dto.teamId} not found`);

    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data: { teamId: dto.teamId },
    });

    const meta: AssignTeamActivityMeta = {
      previousTeamId: contact?.teamId ?? null,
      previousTeamName: contact?.team?.name ?? null,
      newTeamId: dto.teamId,
      newTeamName: newTeam.name,
    };

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'assign_team',
      actorId: dto.actorId,
      subjectTeamId: dto.teamId,
      metadata: meta,
    });

    const updated = await this.findOne(conv.id, conv.workspaceId);
    this.emitter.emit('conversation.updated', updated);
    return updated;
  }

  async unassignTeam(conversationId: string, dto: UnassignTeamDto) {
    const conv = await this.findOrFail(conversationId);

    const contact = await this.prisma.contact.findUnique({
      where: { id: conv.contactId },
      select: { teamId: true, team: { select: { name: true } } },
    });

    if (!contact?.teamId) return;

    await this.prisma.contact.update({
      where: { id: conv.contactId },
      data: { teamId: null },
    });

    const meta: UnassignTeamActivityMeta = {
      previousTeamId: contact.teamId,
      previousTeamName: contact.team?.name ?? 'Unknown',
    };

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'unassign_team',
      actorId: dto.actorId,
      subjectTeamId: contact.teamId,
      metadata: meta,
    });

    const updated = await this.findOne(conv.id, conv.workspaceId);
    this.emitter.emit('conversation.updated', updated);
    return updated;
  }

  async addNote(conversationId: string, dto: AddNoteDto) {
    const conv = await this.findOrFail(conversationId);
    const parsedMentionIds = this.mentionParser.extractUserIds(dto.text);
    const candidateMentionIds = Array.from(
      new Set([...(parsedMentionIds ?? []), ...(dto.mentionedUserIds ?? [])]),
    ).filter((id) => id && id !== dto.actorId);

    const validMentionIds = candidateMentionIds.length > 0
      ? (await this.prisma.workspaceMember.findMany({
        where: {
          workspaceId: conv.workspaceId,
          userId: { in: candidateMentionIds },
        },
        select: { userId: true },
      })).map((member) => member.userId)
      : [];

    const noteActivity = await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'note',
      actorId: dto.actorId,
      actorType: 'user',
      metadata: {
        text: dto.text,
        mentionedUserIds: validMentionIds,
      },
    });

    if (validMentionIds.length > 0) {
      const actor = await this.prisma.user.findUnique({
        where: { id: dto.actorId },
        select: { firstName: true, lastName: true },
      });
      const actorName = [actor?.firstName, actor?.lastName].filter(Boolean).join(' ').trim() || 'A teammate';
      const contactName = this.getContactDisplayName(conv.contact);
      const notePreview = this.mentionParser.toPlainText(dto.text).trim();
      const body = notePreview
        ? `${actorName} mentioned you in a note on ${contactName}: ${notePreview.slice(0, 180)}`
        : `${actorName} mentioned you in a note on ${contactName}.`;

      await Promise.all(
        validMentionIds.map((userId) =>
          this.notifications.ingest({
            userId,
            workspaceId: conv.workspaceId,
            type: NotificationType.COMMENT_MENTION,
            title: 'You were mentioned in a note',
            body,
            metadata: {
              contactId: conv.contactId,
              conversationId: conv.id,
              noteId: noteActivity.id,
              mentionedByUserId: dto.actorId,
              mentionedUserIds: validMentionIds,
            },
            sourceEntityType: 'conversation_activity',
            sourceEntityId: noteActivity.id,
            dedupeKey: `note-mention:${noteActivity.id}:${userId}`,
            target: {
              contactId: conv.contactId,
              conversationId: conv.id,
              mentionedUserIds: validMentionIds,
            },
          }),
        ),
      );
    }

    return noteActivity;
  }

  async mergeContact(conversationId: string, dto: MergeContactDto) {
    const conv = await this.findOrFail(conversationId);

    const mergedContact = await this.prisma.contact.findUnique({
      where: { id: dto.mergedContactId },
      select: { firstName: true, lastName: true },
    });
    if (!mergedContact) throw new BadRequestException(`Contact ${dto.mergedContactId} not found`);

    const survivorContactId = conv.contactId;
    const mergedContactName =
      `${mergedContact.firstName} ${mergedContact.lastName ?? ''}`.trim();

    await this.prisma.$transaction([
      this.prisma.conversation.updateMany({
        where: { contactId: dto.mergedContactId },
        data: { contactId: survivorContactId },
      }),
      this.prisma.contactChannel.updateMany({
        where: { contactId: dto.mergedContactId },
        data: { contactId: survivorContactId },
      }),
      this.prisma.contact.update({
        where: { id: dto.mergedContactId },
        data: { status: 'merged' },
      }),
    ]);

    const meta: MergeContactActivityMeta = {
      mergedContactId: dto.mergedContactId,
      mergedContactName,
      survivorContactId,
    };

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'merge_contact',
      actorId: dto.actorId,
      metadata: meta,
    });
  }

  async changePriority(conversationId: string, dto: ChangePriorityDto) {
    const conv = await this.findOrFail(conversationId);
    if (conv.priority === dto.priority) return conv;

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { priority: dto.priority },
    });

    await this.activity.record({
      workspaceId: conv.workspaceId,
      conversationId: conv.id,
      eventType: 'priority_changed',
      actorId: dto.actorId,
      metadata: { previousPriority: conv.priority, newPriority: dto.priority },
    });

    this.emitter.emit('conversation.updated', { ...updated, workspaceId: conv.workspaceId });
    return updated;
  }

  async recordChannelAdded(
    conversationId: string,
    workspaceId: string,
    meta: ChannelAddedActivityMeta,
    actorId?: string,
  ) {
    await this.activity.record({
      workspaceId,
      conversationId,
      eventType: 'channel_added',
      actorId,
      actorType: actorId ? 'user' : 'system',
      metadata: meta,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** findOrFail without workspace check (for internal calls already validated) */
  private async findOrFail(id: string, workspaceId?: string) {
    const where: Prisma.ConversationWhereUniqueInput = { id };
    const conv = await this.prisma.conversation.findUnique({ where ,include:{contact:true}});
    if (!conv) throw new NotFoundException(`Conversation ${id} not found`);
    if (workspaceId && conv.workspaceId !== workspaceId) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conv;
  }

  private formatMessage(m: any) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      channelId: m.channelId,
      channelType: m.channelType,
      type: m.type,
      direction: m.direction,
      text: m.text,
      subject: m.subject,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
      replyToChannelMsgId: m.replyToChannelMsgId ?? null,
      metadata: m.metadata,
      author: m.author
        ? {
          id: m.author.id,
          name: `${m.author.firstName ?? ''} ${m.author.lastName ?? ''}`.trim(),
          avatarUrl: m.author.avatarUrl,
        }
        : undefined,
      attachments: (m.messageAttachments ?? []).map((a: any) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        url: a.url,
        mimeType: a.mimeType,
        size: a.size,
      })),
    };
  }

  private async enrichMessagesWithReplyContext(messages: any[]) {
    const replyIds = Array.from(
      new Set(
        messages
          .map((message) => message.replyToChannelMsgId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (replyIds.length === 0) return messages;

    const replyTargets = await this.prisma.message.findMany({
      where: {
        channelMsgId: { in: replyIds },
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

    const replyMap = new Map(replyTargets.map((message) => [message.channelMsgId, message]));

    return messages.map((message) => {
      const metadata = (message.metadata as Record<string, any> | null) ?? null;
      if (metadata?.quotedMessage || !message.replyToChannelMsgId) {
        return message;
      }

      const target = replyMap.get(message.replyToChannelMsgId);
      if (!target) return message;

      return {
        ...message,
        metadata: {
          ...(metadata ?? {}),
          quotedMessage: this.buildQuotedMessagePreview(target),
        },
      };
    });
  }

  private buildQuotedMessagePreview(message: any) {
    const attachment = message.messageAttachments?.[0];
    return {
      id: message.id,
      text: message.text ?? undefined,
      author: this.getQuotedMessageAuthor(message),
      attachmentType: this.normaliseQuotedAttachmentType(attachment?.type),
      attachmentUrl: attachment?.url ?? undefined,
    };
  }

  private getQuotedMessageAuthor(message: any) {
    if (message.direction === 'outgoing') {
      const name = [message.author?.firstName, message.author?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      return name || 'You';
    }

    const contact = message.conversation?.contact;
    const name = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
    return name || contact?.email || contact?.phone || 'Customer';
  }

  private normaliseQuotedAttachmentType(type?: string) {
    if (!type) return undefined;
    if (type === 'voice') return 'audio';
    if (type === 'image' || type === 'video' || type === 'audio') return type;
    return 'file';
  }

  private buildSnippet(text: string, q: string, radius = 80): string {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text.slice(0, radius * 2);
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + q.length + radius);
    const snippet = text.slice(start, end);
    return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '');
  }

  private buildQueuePayload(
    channelType: string,
    to: string,
    dto: SendMessageDto,
  ): Record<string, any> {
    switch (channelType) {
      case 'whatsapp':
        return {
          messaging_product: 'whatsapp',
          to,
          type: dto.attachments?.length ? dto.attachments[0].type : 'text',
          text: dto.text ? { body: dto.text } : undefined,
        };
      case 'instagram':
      case 'messenger':
        return {
          recipient: { id: to },
          message: { text: dto.text },
        };
      case 'email':
        return {
          to,
          subject: dto.metadata?.email?.subject ?? '',
          text: dto.text,
          html: dto.metadata?.email?.htmlBody,
          inReplyTo: dto.metadata?.email?.inReplyTo,
          references: dto.metadata?.email?.references,
        };
      default:
        return { to, text: dto.text };
    }
  }

  private statusToEvent(prev: string, next: string) {
    if (next === 'open' && prev !== 'open') return 'reopen';
    if (next === 'open' && !prev) return 'open';
    if (next === 'closed' || next === 'resolved') return 'close';
    if (next === 'pending') return 'pending';
    return 'open' as const;
  }

  private getContactDisplayName(contact?: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null) {
    const fullName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
    return fullName || contact?.email || contact?.phone || 'this contact';
  }
}
