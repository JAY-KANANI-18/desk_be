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
  ConflictException,
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
import { MessageProcessingQueueService } from '../outbound/message-processing-queue.service';
import { RealtimeService } from '../../realtime/realtime.service';
import {
  isPhoneIdentifierChannel,
  normalizeContactIdentifierForChannel,
} from '../../common/utils/contact-identifier.util';
import {
  buildCommonVariableContext,
  renderVariableTemplate,
  type VariableRenderContext,
} from '../../common/variables/variable-metadata';

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

export interface ConversationCountBucket {
  total: number;
  unread: number;
}

export interface ConversationCountSummary {
  all: ConversationCountBucket;
  mine: ConversationCountBucket;
  unassigned: ConversationCountBucket;
}

export interface SendMessageDto {
  workspaceId: string;
  conversationId: string;
  channelId: string;
  actorId: string;
  text?: string;
  subject?: string;
  attachments?: Array<{
    type: string;
    url: string;
    name: string;
    mimeType?: string;
  }>;
  replyToMessageId?: string;
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

type MessageVariableContext = VariableRenderContext;

export interface ChangePriorityDto {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  actorId?: string;
}

export interface UpdateStatusDto {
  status: 'open' | 'pending' | 'resolved' | 'closed';
  actorId?: string;
  actorType?: 'user' | 'system' | 'automation';
}

export interface GetTimelineOptions {
  cursor?: string;
  limit?: number;
  anchorMessageId?: string;
  aroundMessageId?: string;
  direction?: 'older' | 'newer';
  before?: number;
  after?: number;
}

const CONTACT_CHANNEL_SELECT = {
  id: true,
  channelId: true,
  channelType: true,
  identifier: true,
  displayName: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  lastMessageTime: true,
  lastIncomingMessageTime: true,
  lastCallInteractionTime: true,
  messageWindowExpiry: true,
  conversationWindowCategory: true,
  call_permission: true,
  hasPermanentCallPermission: true,
} satisfies Prisma.ContactChannelSelect;

const CONFLICTING_CONTACT_CHANNEL_SELECT = {
  id: true,
  contactId: true,
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      avatarUrl: true,
      company: true,
    },
  },
} satisfies Prisma.ContactChannelSelect;

const INITIATABLE_CONTACT_FIELD_BY_CHANNEL = {
  email: 'email',
  gmail: 'email',
  whatsapp: 'phone',
  sms: 'phone',
  exotel_call: 'phone',
} as const;

type InitiatableContactField =
  (typeof INITIATABLE_CONTACT_FIELD_BY_CHANNEL)[keyof typeof INITIATABLE_CONTACT_FIELD_BY_CHANNEL];
type SelectedContactChannel = Prisma.ContactChannelGetPayload<{ select: typeof CONTACT_CHANNEL_SELECT }>;
type ConflictingContactChannel = Prisma.ContactChannelGetPayload<{
  select: typeof CONFLICTING_CONTACT_CHANNEL_SELECT;
}>;

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
        select: CONTACT_CHANNEL_SELECT,
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
    private readonly processingQueue: MessageProcessingQueueService,
    private readonly realtime: RealtimeService,
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

    // ── Build where clause ────────────────────────────────────────────────────
    const where: Prisma.ConversationWhereInput = { workspaceId };
    const contactWhere: Prisma.ContactWhereInput = {};

    if (status && status !== 'all') {
      contactWhere.status = status;
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
        contactWhere.assigneeId = null;
      } else if (assigneeId === 'me' && actorUserId) {
        contactWhere.assigneeId = actorUserId;
      } else {
        // specific UUID
        contactWhere.assigneeId = assigneeId;
      }
    }
    if (lifecycleId) {
      contactWhere.lifecycleId = lifecycleId;
    }

    if (teamId) {
      contactWhere.teamId = teamId;
    }

    // Search by contact name / email / phone
    if (search?.trim()) {
      contactWhere.OR = this.buildContactSearchClauses(search);
    }

    if (Object.keys(contactWhere).length > 0) {
      where.contact = contactWhere;
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

  async getCountSummary(
    workspaceId: string,
    opts: Omit<FindAllOptions, 'workspaceId'> = {},
  ): Promise<ConversationCountSummary> {
    const baseWhere = this.buildConversationCountWhere(workspaceId, opts);
    const mineWhere = opts.actorUserId
      ? this.withContactWhere(baseWhere, { assigneeId: opts.actorUserId })
      : null;

    const [all, mine, unassigned] = await Promise.all([
      this.conversationCountBucket(baseWhere),
      mineWhere
        ? this.conversationCountBucket(mineWhere)
        : Promise.resolve({ total: 0, unread: 0 }),
      this.conversationCountBucket(
        this.withContactWhere(baseWhere, { assigneeId: null }),
      ),
    ]);

    return { all, mine, unassigned };
  }

  private buildConversationCountWhere(
    workspaceId: string,
    opts: Omit<FindAllOptions, 'workspaceId'> = {},
  ): Prisma.ConversationWhereInput {
    const {
      status,
      priority,
      direction,
      teamId,
      unreplied = false,
      search,
    } = opts;
    const where: Prisma.ConversationWhereInput = { workspaceId };
    const contactWhere: Prisma.ContactWhereInput = {};

    if (status && status !== 'all') {
      contactWhere.status = status;
    }

    if (priority && priority !== 'all') {
      where.priority = priority;
    }

    if (direction && direction !== 'all') {
      where.lastMessage = { direction };
    }

    if (unreplied) {
      where.lastMessage = { direction: 'incoming' };
    }

    if (teamId) {
      contactWhere.teamId = teamId;
    }

    if (search?.trim()) {
      contactWhere.OR = this.buildContactSearchClauses(search);
    }

    if (Object.keys(contactWhere).length > 0) {
      where.contact = contactWhere;
    }

    return where;
  }

  private withContactWhere(
    where: Prisma.ConversationWhereInput,
    contactWhere: Prisma.ContactWhereInput,
  ): Prisma.ConversationWhereInput {
    const currentContactWhere = (where.contact ?? {}) as Prisma.ContactWhereInput;

    return {
      ...where,
      contact: {
        ...currentContactWhere,
        ...contactWhere,
      },
    };
  }

  private async conversationCountBucket(
    where: Prisma.ConversationWhereInput,
  ): Promise<ConversationCountBucket> {
    const result = await this.prisma.conversation.aggregate({
      where,
      _count: { _all: true },
      _sum: { unreadCount: true },
    });

    return {
      total: result._count._all,
      unread: result._sum.unreadCount ?? 0,
    };
  }

  private buildContactSearchClauses(search: string): Prisma.ContactWhereInput[] {
    const normalizedSearch = search.trim().replace(/\s+/g, ' ');
    const words = normalizedSearch.split(' ').filter(Boolean);
    const clauses = this.buildContactSearchFieldClauses(normalizedSearch);

    if (words.length > 1) {
      clauses.push({
        AND: words.map((word) => ({
          OR: this.buildContactSearchFieldClauses(word),
        })),
      });

      const firstWord = words[0];
      const remainingWords = words.slice(1).join(' ');

      clauses.push(
        {
          AND: [
            { firstName: { contains: firstWord, mode: 'insensitive' } },
            { lastName: { contains: remainingWords, mode: 'insensitive' } },
          ],
        },
        {
          AND: [
            { lastName: { contains: firstWord, mode: 'insensitive' } },
            { firstName: { contains: remainingWords, mode: 'insensitive' } },
          ],
        },
      );
    }

    return clauses;
  }

  private buildContactSearchFieldClauses(search: string): Prisma.ContactWhereInput[] {
    return [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
    ];
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

    if (contact.status !== 'open') {
      await this.prisma.contact.update({
        where: { id: contactId },
        data: { status: 'open' },
      });
    }

    const conv = await this.prisma.conversation.create({
      data: {
        workspaceId,
        contactId,

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
      metadata: { previousStatus: contact.status ?? null } satisfies OpenActivityMeta,
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
    opts: GetTimelineOptions = {},
  ) {
    const limit = Math.min(opts.limit ?? 30, 100);

    if (opts.aroundMessageId) {
      return this.getTimelineAroundMessage(conversationId, workspaceId, {
        aroundMessageId: opts.aroundMessageId,
        before: opts.before,
        after: opts.after,
        limit,
      });
    }

    if (opts.anchorMessageId) {
      return this.getTimelineFromAnchor(conversationId, workspaceId, {
        anchorMessageId: opts.anchorMessageId,
        direction: opts.direction ?? 'older',
        limit,
      });
    }

    return this.getLatestTimeline(conversationId, workspaceId, {
      cursor: opts.cursor,
      limit,
    });
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

    if (dto.actorId && conv.contact?.assigneeId !== dto.actorId) {
      await this.assignUser(dto.conversationId, {
        userId: dto.actorId,
        actorId: dto.actorId,
      });
    }

    const channel = await this.prisma.channel.findFirst({
      where: { id: dto.channelId, workspaceId: dto.workspaceId },
    });
    if (!channel) throw new NotFoundException(`Channel ${dto.channelId} not found`);

    const { contactChannel, created: createdContactChannel } =
      await this.resolveSendContactChannel({
        workspaceId: dto.workspaceId,
        channel,
        contact: conv.contact,
      });
    const to = contactChannel?.identifier ?? this.resolveContactFieldIdentifier(channel.type, conv.contact, dto);
    if (!to) {
      throw new BadRequestException(
        `No reachable identifier found for contact ${conv.contactId} on channel ${dto.channelId}. ` +
        `Cannot send — contact has never messaged on this channel.`,
      );
    }

    if (createdContactChannel) {
      await this.recordChannelAdded(
        dto.conversationId,
        dto.workspaceId,
        {
          channelType: channel.type,
          identifier: to,
          channelName: channel.name,
          channelId: channel.id,
        },
        dto.actorId,
      );
      await this.emitContactChannelsUpdated(dto.workspaceId, conv.contactId);
    }

    const variableContext = await this.buildMessageVariableContext(conv, dto.actorId);
    const deliveryDto: SendMessageDto = {
      ...dto,
      text: this.renderMessageVariables(dto.text, variableContext),
      subject: this.renderMessageVariables(dto.subject, variableContext),
      metadata: this.renderMessageMetadata(dto.metadata, variableContext),
    };

    // Create Message row
    const message = await this.prisma.message.create({
      data: {
        workspaceId: deliveryDto.workspaceId,
        conversationId: deliveryDto.conversationId,
        channelId: deliveryDto.channelId,
        channelType: channel.type,
        type: deliveryDto.metadata?.template
          ? 'template'
          : deliveryDto.attachments?.length
          ? deliveryDto.attachments[0].type
          : 'text',
        direction: 'outgoing',
        text: deliveryDto.text ?? null,
        subject: deliveryDto.subject ?? null,
        status: 'pending',
        authorId: deliveryDto.actorId,
        replyToChannelMsgId: deliveryDto.replyToMessageId ?? deliveryDto.metadata?.replyToMessageId ?? null,
        metadata: deliveryDto.metadata ? (deliveryDto.metadata as any) : undefined,
        sentAt: new Date(),
      },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        messageAttachments: true,
        channel: true,
      },
    });

    // Persist attachments
    if (deliveryDto.attachments?.length) {
      await this.prisma.messageAttachment.createMany({
        data: deliveryDto.attachments.map(a => ({
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
    const payload = this.buildQueuePayload(channel.type, to, deliveryDto);
    const queueEntry = await this.prisma.outboundQueue.create({
      data: {
        workspaceId: deliveryDto.workspaceId,
        channelId: deliveryDto.channelId,
        messageId: message.id,
        to,
        payload,
        status: 'pending',
      },
    });
    await this.processingQueue.enqueueQueueEntry(queueEntry.id);

    // Emit for real-time FE delivery
    this.emitter.emit('message.outbound', {
      workspaceId: deliveryDto.workspaceId,
      conversationId: deliveryDto.conversationId,
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
    const variableContext = await this.buildMessageVariableContext(conv, dto.actorId);
    const text = this.renderMessageVariables(dto.text, variableContext) ?? '';
    const parsedMentionIds = this.mentionParser.extractUserIds(text);
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
        text,
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
      const notePreview = this.mentionParser.toPlainText(text).trim();
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

  private formatMessageMetadata(metadata: unknown, rawPayload: unknown) {
    const base = this.isRecord(metadata) ? { ...metadata } : metadata;
    if (!this.isRecord(base)) return base;

    const raw = this.isRecord(rawPayload) ? rawPayload : null;
    const rawHtml = typeof raw?.['body-html'] === 'string' ? raw['body-html'] : '';
    const rawPlain = typeof raw?.['body-plain'] === 'string' ? raw['body-plain'] : '';
    const email = this.isRecord(base.email) ? { ...base.email } : {};
    const currentHtml =
      typeof email.htmlBody === 'string'
        ? email.htmlBody
        : typeof base.htmlBody === 'string'
          ? base.htmlBody
          : '';
    let emailChanged = false;

    if (
      rawHtml &&
      this.hasForwardedMarker(`${rawPlain}\n${rawHtml}\n${currentHtml}`) &&
      rawHtml.length > currentHtml.length
    ) {
      email.htmlBody = rawHtml;
      base.htmlBody = rawHtml;
      emailChanged = true;
    }

    const rawEnvelopeSender =
      this.getStringField(raw?.sender) ??
      this.getStringField(raw?.['X-Envelope-From']);
    if (rawEnvelopeSender && !email.envelopeSender) {
      email.envelopeSender = rawEnvelopeSender;
      emailChanged = true;
    }

    const rawFrom = raw ? this.getRawMailHeader(raw, 'From') : undefined;
    const currentFrom =
      this.getStringField(email.from) ??
      this.getStringField(base.from) ??
      '';

    if (rawFrom && this.shouldUseHeaderFrom(currentFrom, rawFrom, rawEnvelopeSender)) {
      email.from = rawFrom;
      base.from = rawFrom;

      const senderName = this.extractEmailName(rawFrom);
      if (senderName) {
        email.senderName = senderName;
        base.senderName = senderName;
      }

      emailChanged = true;
    }

    if (emailChanged) {
      base.email = email;
    }

    return base;
  }

  private getRawMailHeader(raw: Record<string, any>, name: string): string | undefined {
    const direct =
      this.getStringField(raw[name]) ??
      this.getStringField(raw[name.toLowerCase()]);
    if (direct) return direct;

    const messageHeaders = raw['message-headers'];
    if (!messageHeaders) return undefined;

    let headers: unknown = messageHeaders;
    if (typeof messageHeaders === 'string') {
      try {
        headers = JSON.parse(messageHeaders);
      } catch {
        return undefined;
      }
    }

    if (!Array.isArray(headers)) return undefined;

    const match = headers.find((header): header is [string, string] => (
      Array.isArray(header) &&
      typeof header[0] === 'string' &&
      typeof header[1] === 'string' &&
      header[0].toLowerCase() === name.toLowerCase()
    ));

    return match?.[1]?.trim() || undefined;
  }

  private shouldUseHeaderFrom(
    currentFrom: string,
    headerFrom: string,
    envelopeSender?: string,
  ): boolean {
    const currentEmail = this.extractEmailAddress(currentFrom);
    const headerEmail = this.extractEmailAddress(headerFrom);
    const envelopeEmail = this.extractEmailAddress(envelopeSender ?? '');

    if (!headerEmail || currentEmail === headerEmail) return false;
    if (!currentEmail) return true;
    if (envelopeEmail && currentEmail === envelopeEmail) return true;

    return this.isGeneratedSesEnvelopeAddress(currentEmail);
  }

  private extractEmailAddress(value: string): string {
    return (value.match(/<(.+?)>/)?.[1] ?? value).trim().toLowerCase();
  }

  private extractEmailName(value: string): string | undefined {
    return value.match(/^(.+?)\s*</)?.[1]?.replace(/"/g, '').trim();
  }

  private isGeneratedSesEnvelopeAddress(email: string): boolean {
    return /-[0-9]{6}@amazonses\.com$/i.test(email);
  }

  private getStringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private hasForwardedMarker(value: string) {
    return (
      /-{2,}\s*Forwarded message\s*-{2,}/i.test(value) ||
      /Begin forwarded message:/i.test(value) ||
      /-{2,}\s*Original Message\s*-{2,}/i.test(value)
    );
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
      metadata: this.formatMessageMetadata(m.metadata, m.rawPayload),
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
        if (dto.metadata?.template) {
          return {
            to,
            template: {
              id: dto.metadata.template.id,
              metaId: dto.metadata.template.metaId,
              name: dto.metadata.template.name,
              language: dto.metadata.template.language,
              variables: dto.metadata.template.variables ?? {},
            },
          };
        }
        return {
          messaging_product: 'whatsapp',
          to,
          ...(dto.attachments?.length
            ? {
                type: dto.attachments[0].type === 'document' ? 'document' : dto.attachments[0].type,
                [dto.attachments[0].type === 'document' ? 'document' : dto.attachments[0].type]: {
                  link: dto.attachments[0].url,
                  ...(dto.attachments[0].name ? { filename: dto.attachments[0].name } : {}),
                  ...(dto.text ? { caption: dto.text } : {}),
                },
              }
            : {
                type: 'text',
                text: dto.text ? { body: dto.text } : undefined,
              }),
          ...(dto.replyToMessageId ? { context: { message_id: dto.replyToMessageId } } : {}),
        };
      case 'instagram':
      case 'messenger':
        if (dto.metadata?.template) {
          return {
            to,
            template: {
              id: dto.metadata.template.id,
              metaId: dto.metadata.template.metaId,
              name: dto.metadata.template.name,
              language: dto.metadata.template.language,
              variables: dto.metadata.template.variables ?? {},
            },
          };
        }
        return {
          recipient: { id: to },
          message: {
            ...(dto.text ? { text: dto.text } : {}),
            ...(dto.attachments?.length
              ? {
                  attachment: {
                    type: dto.attachments[0].mimeType?.startsWith('image/')
                      ? 'image'
                      : dto.attachments[0].mimeType?.startsWith('video/')
                        ? 'video'
                        : dto.attachments[0].mimeType?.startsWith('audio/')
                          ? 'audio'
                          : 'file',
                    payload: {
                      url: dto.attachments[0].url,
                      is_reusable: true,
                    },
                  },
                }
              : {}),
            ...(dto.metadata?.quickReplies?.length
              ? {
                  quick_replies: dto.metadata.quickReplies.map((qr: any) => ({
                    content_type: 'text',
                    title: qr.title,
                    payload: qr.payload,
                  })),
                }
              : {}),
          },
        };
      case 'email':
        return {
          to,
          subject: dto.subject ?? dto.metadata?.email?.subject ?? '',
          text: dto.text,
          html: dto.metadata?.htmlBody ?? dto.metadata?.email?.htmlBody,
          headers: {
            ...(dto.metadata?.email?.inReplyTo
              ? { 'In-Reply-To': dto.metadata.email.inReplyTo }
              : {}),
            ...(dto.metadata?.email?.references
              ? { References: dto.metadata.email.references }
              : {}),
          },
          attachments: dto.attachments ?? [],
        };
      default:
        return { to, text: dto.text, attachments: dto.attachments ?? [] };
    }
  }

  private async resolveSendContactChannel(opts: {
    workspaceId: string;
    channel: { id: string; type: string; name?: string | null };
    contact: {
      id: string;
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
      phone?: string | null;
    };
  }): Promise<{ contactChannel: SelectedContactChannel | null; created: boolean }> {
    const existing = await this.prisma.contactChannel.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        contactId: opts.contact.id,
        channelId: opts.channel.id,
      },
      select: CONTACT_CHANNEL_SELECT,
    });

    const now = BigInt(Date.now());
    if (existing?.identifier) {
      const normalizedExistingIdentifier =
        normalizeContactIdentifierForChannel(opts.channel.type, existing.identifier) ?? existing.identifier.trim();
      if (normalizedExistingIdentifier && normalizedExistingIdentifier !== existing.identifier) {
        const conflicting = await this.findConflictingContactChannel({
          workspaceId: opts.workspaceId,
          channelId: opts.channel.id,
          identifier: normalizedExistingIdentifier,
        });
        if (conflicting && conflicting.contactId !== opts.contact.id) {
          this.throwContactChannelConflict(opts.channel.type, normalizedExistingIdentifier, conflicting);
        }
      }

      return {
        contactChannel: await this.prisma.contactChannel.update({
          where: { id: existing.id },
          data: {
            lastMessageTime: now,
            ...(normalizedExistingIdentifier && normalizedExistingIdentifier !== existing.identifier
              ? { identifier: normalizedExistingIdentifier }
              : {}),
          },
          select: CONTACT_CHANNEL_SELECT,
        }),
        created: false,
      };
    }

    const identifier = this.resolveContactFieldIdentifier(opts.channel.type, opts.contact);
    if (!identifier) {
      return { contactChannel: existing, created: false };
    }

    const conflicting = await this.findConflictingContactChannel({
      workspaceId: opts.workspaceId,
      channelId: opts.channel.id,
      identifier,
      legacyIdentifier: isPhoneIdentifierChannel(opts.channel.type) ? opts.contact.phone : null,
    });
    if (conflicting && conflicting.contactId !== opts.contact.id) {
      this.throwContactChannelConflict(opts.channel.type, identifier, conflicting);
    }
    if (conflicting) {
      return {
        contactChannel: await this.prisma.contactChannel.update({
          where: { id: conflicting.id },
          data: { lastMessageTime: now },
          select: CONTACT_CHANNEL_SELECT,
        }),
        created: false,
      };
    }

    const displayName = [opts.contact.firstName, opts.contact.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      contactChannel: await this.prisma.contactChannel.create({
        data: {
          workspaceId: opts.workspaceId,
          contactId: opts.contact.id,
          channelId: opts.channel.id,
          channelType: opts.channel.type,
          identifier,
          displayName: displayName || null,
          lastMessageTime: now,
        },
        select: CONTACT_CHANNEL_SELECT,
      }),
      created: true,
    };
  }

  private async emitContactChannelsUpdated(workspaceId: string, contactId: string) {
    const contactChannels = await this.prisma.contactChannel.findMany({
      where: { workspaceId, contactId },
      orderBy: { createdAt: 'asc' },
      select: CONTACT_CHANNEL_SELECT,
    });

    this.realtime.emitToWorkspace(workspaceId, 'contact:updated', {
      id: contactId,
      contactChannels,
    });
  }

  private async findConflictingContactChannel(opts: {
    workspaceId: string;
    channelId: string;
    identifier: string;
    legacyIdentifier?: string | null;
  }): Promise<ConflictingContactChannel | null> {
    const identifiers = Array.from(
      new Set(
        [opts.identifier, opts.legacyIdentifier?.trim()]
          .filter((value): value is string => Boolean(value)),
      ),
    );

    return this.prisma.contactChannel.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        identifier: { in: identifiers },
      },
      select: CONFLICTING_CONTACT_CHANNEL_SELECT,
    });
  }

  private throwContactChannelConflict(
    channelType: string,
    identifier: string,
    conflicting: ConflictingContactChannel,
  ): never {
    const existingContactName = this.getContactDisplayName(conflicting.contact);
    const existingContactLabel = this.getConflictContactLabel(conflicting.contact);
    const channelLabel = this.getChannelLabel(channelType);
    this.logger.warn(
      `ContactChannel already exists on another contact for outbound identity. channelType=${channelType} identifier=${identifier} existingContactId=${conflicting.contactId}`,
    );
    throw new ConflictException({
      code: 'CONTACT_CHANNEL_IDENTIFIER_CONFLICT',
      message:
        `This ${channelLabel} is already used by ${existingContactLabel}. ` +
        `Click Merge in Contact details first, then send again. This keeps replies and message history together.`,
      retryable: false,
      channelType,
      identifier,
      identifierField: this.getInitiatableContactField(channelType),
      channelLabel,
      existingContactId: conflicting.contactId,
      existingContactName,
      existingContact: conflicting.contact,
    });
  }

  private getConflictContactLabel(contact: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
  } | null) {
    const fullName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
    return fullName || contact?.company || 'another contact';
  }

  private resolveContactFieldIdentifier(
    channelType: string | null | undefined,
    contact: { email?: string | null; phone?: string | null } | null | undefined,
    dto?: SendMessageDto,
  ): string | null {
    const field = this.getInitiatableContactField(channelType);
    if (field === 'email') {
      return normalizeContactIdentifierForChannel(
        channelType,
        this.getStringField(dto?.metadata?.email?.to) ?? contact?.email,
      );
    }

    if (field === 'phone') {
      return normalizeContactIdentifierForChannel(channelType, contact?.phone);
    }

    return null;
  }

  private getInitiatableContactField(channelType: string | null | undefined): InitiatableContactField | null {
    const normalizedChannelType = String(channelType ?? '').toLowerCase();
    return INITIATABLE_CONTACT_FIELD_BY_CHANNEL[
      normalizedChannelType as keyof typeof INITIATABLE_CONTACT_FIELD_BY_CHANNEL
    ] ?? null;
  }

  private getChannelLabel(channelType: string | null | undefined) {
    const normalizedChannelType = String(channelType ?? '').toLowerCase();
    switch (normalizedChannelType) {
      case 'whatsapp':
        return 'WhatsApp number';
      case 'sms':
        return 'SMS number';
      case 'exotel_call':
        return 'phone number';
      case 'email':
      case 'gmail':
        return 'email address';
      default:
        return `${normalizedChannelType || 'channel'} identifier`;
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
    company?: string | null;
  } | null) {
    const fullName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim();
    return fullName || contact?.email || contact?.phone || 'this contact';
  }

  private async buildMessageVariableContext(
    conversation: {
      id: string;
      workspaceId: string;
      contact?: {
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        phone?: string | null;
        company?: string | null;
      } | null;
    },
    actorId?: string | null,
  ): Promise<MessageVariableContext> {
    const [actor, workspace, lastMessage] = await Promise.all([
      actorId
        ? this.prisma.user.findUnique({
          where: { id: actorId },
          select: { firstName: true, lastName: true, email: true },
        })
        : Promise.resolve(null),
      this.prisma.workspace.findUnique({
        where: { id: conversation.workspaceId },
        select: { name: true, timeZone: true },
      }),
      this.prisma.message.findFirst({
        where: {
          workspaceId: conversation.workspaceId,
          conversationId: conversation.id,
        },
        orderBy: { createdAt: 'desc' },
        select: { text: true, subject: true },
      }),
    ]);

    const contact = conversation.contact;
    const lastMessageText = lastMessage?.text ?? lastMessage?.subject ?? '';
    const todayDate = new Intl.DateTimeFormat('en-US', {
      timeZone: workspace?.timeZone ?? 'UTC',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    }).format(new Date());

    return buildCommonVariableContext({
      contact,
      agent: actor,
      company: workspace,
      conversation: {
        id: conversation.id,
        lastMessage: lastMessageText,
      },
      today: { date: todayDate },
    });
  }

  private renderMessageVariables(
    value: string | null | undefined,
    context: MessageVariableContext,
  ): string | undefined {
    if (value === null || value === undefined) return undefined;

    return renderVariableTemplate(value, context);
  }

  private renderMessageMetadata(
    metadata: Record<string, any> | undefined,
    context: MessageVariableContext,
  ) {
    if (!metadata) return undefined;

    const next = { ...metadata };

    if (typeof next.htmlBody === 'string') {
      next.htmlBody = this.renderMessageVariables(next.htmlBody, context);
    }

    if (next.email && typeof next.email === 'object') {
      next.email = { ...next.email };
      if (typeof next.email.subject === 'string') {
        next.email.subject = this.renderMessageVariables(next.email.subject, context);
      }
      if (typeof next.email.htmlBody === 'string') {
        next.email.htmlBody = this.renderMessageVariables(next.email.htmlBody, context);
      }
    }

    if (next.template && typeof next.template === 'object') {
      next.template = { ...next.template };
      if (next.template.variables && typeof next.template.variables === 'object') {
        next.template.variables = this.renderMessageTemplateVariables(
          next.template.variables,
          context,
        );
      }
    }

    return next;
  }

  private renderMessageTemplateVariables(
    variables: Record<string, unknown>,
    context: MessageVariableContext,
  ) {
    return Object.entries(variables).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === 'string') {
        acc[key] = this.renderMessageVariables(value, context) ?? '';
      } else if (value === null || value === undefined) {
        acc[key] = '';
      } else {
        acc[key] = String(value);
      }

      return acc;
    }, {});
  }

  private async getLatestTimeline(
    conversationId: string,
    workspaceId: string,
    opts: { cursor?: string; limit: number },
  ) {
    let cursorDate: Date | undefined;
    if (opts.cursor) {
      try {
        cursorDate = new Date(Buffer.from(opts.cursor, 'base64').toString('utf8'));
      } catch {
        cursorDate = undefined;
      }
    }

    const page = await this.fetchTimelineSlice({
      conversationId,
      workspaceId,
      olderThan: cursorDate,
      limit: opts.limit,
      order: 'desc',
    });

    return {
      data: page.items.map((item) => this.toTimelineItem(item)).reverse(),
      nextCursor: page.hasMore
        ? Buffer.from(page.items[page.items.length - 1].timestamp.toISOString()).toString('base64')
        : undefined,
      hasMoreOlder: page.hasMore,
      hasMoreNewer: false,
      targetFound: true,
      targetMessageId: null,
    };
  }

  private async getTimelineAroundMessage(
    conversationId: string,
    workspaceId: string,
    opts: { aroundMessageId: string; before?: number; after?: number; limit: number },
  ) {
    const targetMessage = await this.prisma.message.findFirst({
      where: {
        id: opts.aroundMessageId,
        conversationId,
        workspaceId,
      },
      include: {
        author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        messageAttachments: true,
      },
    });

    if (!targetMessage) {
      return this.getLatestTimeline(conversationId, workspaceId, {
        limit: opts.limit,
      }).then((result) => ({
        ...result,
        targetFound: false,
        targetMessageId: opts.aroundMessageId,
      }));
    }

    const beforeCount = Math.min(opts.before ?? Math.floor(opts.limit / 2), 100);
    const afterCount = Math.min(opts.after ?? Math.floor(opts.limit / 2), 100);

    const [olderPage, newerPage, olderExists, newerExists] = await Promise.all([
      this.fetchTimelineSlice({
        conversationId,
        workspaceId,
        olderThan: targetMessage.createdAt,
        limit: beforeCount,
        order: 'desc',
      }),
      this.fetchTimelineSlice({
        conversationId,
        workspaceId,
        newerThan: targetMessage.createdAt,
        limit: afterCount,
        order: 'asc',
      }),
      this.timelineItemExists({
        conversationId,
        workspaceId,
        olderThan: targetMessage.createdAt,
      }),
      this.timelineItemExists({
        conversationId,
        workspaceId,
        newerThan: targetMessage.createdAt,
      }),
    ]);

    const enrichedTarget = await this.enrichMessagesWithReplyContext([targetMessage]);
    const items = [
      ...olderPage.items.reverse(),
      {
        type: 'message' as const,
        timestamp: enrichedTarget[0].sentAt ?? enrichedTarget[0].createdAt,
        raw: enrichedTarget[0],
      },
      ...newerPage.items,
    ];

    return {
      data: items.map((item) => this.toTimelineItem(item)),
      hasMoreOlder: olderExists,
      hasMoreNewer: newerExists,
      targetFound: true,
      targetMessageId: targetMessage.id,
    };
  }

  private async getTimelineFromAnchor(
    conversationId: string,
    workspaceId: string,
    opts: { anchorMessageId: string; direction: 'older' | 'newer'; limit: number },
  ) {
    const anchorMessage = await this.prisma.message.findFirst({
      where: {
        id: opts.anchorMessageId,
        conversationId,
        workspaceId,
      },
      select: { id: true, createdAt: true },
    });

    if (!anchorMessage) {
      return {
        data: [],
        hasMoreOlder: false,
        hasMoreNewer: false,
        targetFound: false,
        targetMessageId: opts.anchorMessageId,
      };
    }

    const page = await this.fetchTimelineSlice({
      conversationId,
      workspaceId,
      olderThan: opts.direction === 'older' ? anchorMessage.createdAt : undefined,
      newerThan: opts.direction === 'newer' ? anchorMessage.createdAt : undefined,
      limit: opts.limit,
      order: opts.direction === 'older' ? 'desc' : 'asc',
    });

    return {
      data: (opts.direction === 'older' ? page.items.reverse() : page.items).map((item) =>
        this.toTimelineItem(item),
      ),
      hasMoreOlder: opts.direction === 'older' ? page.hasMore : undefined,
      hasMoreNewer: opts.direction === 'newer' ? page.hasMore : undefined,
      targetFound: true,
      targetMessageId: null,
    };
  }

  private async fetchTimelineSlice(params: {
    conversationId: string;
    workspaceId: string;
    limit: number;
    order: 'asc' | 'desc';
    olderThan?: Date;
    newerThan?: Date;
  }) {
    const comparator =
      params.olderThan
        ? { lt: params.olderThan }
        : params.newerThan
          ? { gt: params.newerThan }
          : undefined;

    const [messages, activities] = await Promise.all([
      this.prisma.message.findMany({
        where: {
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          ...(comparator ? { createdAt: comparator } : {}),
        },
        orderBy: { createdAt: params.order },
        take: params.limit + 1,
        include: {
          author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          messageAttachments: true,
        },
      }),
      this.prisma.conversationActivity.findMany({
        where: {
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          ...(comparator ? { createdAt: comparator } : {}),
        },
        orderBy: { createdAt: params.order },
        take: params.limit + 1,
        include: {
          actor: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          subjectUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          subjectTeam: { select: { id: true, name: true } },
        },
      }),
    ]);

    const enrichedMessages = await this.enrichMessagesWithReplyContext(messages);

    const items: Array<{ timestamp: Date; raw: any; type: 'message' | 'activity' }> = [
      ...enrichedMessages.map((message) => ({
        type: 'message' as const,
        timestamp: message.sentAt ?? message.createdAt,
        raw: message,
      })),
      ...activities.map((activity) => ({
        type: 'activity' as const,
        timestamp: activity.createdAt,
        raw: activity,
      })),
    ].sort((a, b) =>
      params.order === 'asc'
        ? a.timestamp.getTime() - b.timestamp.getTime()
        : b.timestamp.getTime() - a.timestamp.getTime(),
    );

    return {
      items: items.slice(0, params.limit),
      hasMore: items.length > params.limit,
    };
  }

  private async timelineItemExists(params: {
    conversationId: string;
    workspaceId: string;
    olderThan?: Date;
    newerThan?: Date;
  }) {
    const comparator =
      params.olderThan
        ? { lt: params.olderThan }
        : params.newerThan
          ? { gt: params.newerThan }
          : undefined;

    const [message, activity] = await Promise.all([
      this.prisma.message.findFirst({
        where: {
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          ...(comparator ? { createdAt: comparator } : {}),
        },
        select: { id: true },
      }),
      this.prisma.conversationActivity.findFirst({
        where: {
          conversationId: params.conversationId,
          workspaceId: params.workspaceId,
          ...(comparator ? { createdAt: comparator } : {}),
        },
        select: { id: true },
      }),
    ]);

    return !!message || !!activity;
  }

  private toTimelineItem(item: { timestamp: Date; raw: any; type: 'message' | 'activity' }) {
    if (item.type === 'message') {
      return {
        id: item.raw.id,
        type: 'message' as const,
        timestamp: item.timestamp.toISOString(),
        message: this.formatMessage(item.raw),
      };
    }

    return {
      id: item.raw.id,
      type: 'activity' as const,
      timestamp: item.timestamp.toISOString(),
      activity: this.activity.toResponsePublic(item.raw),
    };
  }
}
