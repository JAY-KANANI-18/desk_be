// src/activity/activity.service.ts
//
// Responsible for:
//   1. Writing ConversationActivity rows (called from conversation service,
//      inbound service, and any future automation)
//   2. Reading activities for the timeline API
//   3. Building human-readable description strings

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CreateActivityDto,
  ActivityResponse,
  ActivityEventType,
  AssignUserActivityMeta,
  UnassignUserActivityMeta,
  AssignTeamActivityMeta,
  UnassignTeamActivityMeta,
  MergeContactActivityMeta,
  ChannelAddedActivityMeta,
  NoteActivityMeta,
  PriorityChangedActivityMeta,
  OpenActivityMeta,
  CloseActivityMeta,
} from './activity.types';

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Write ────────────────────────────────────────────────────────────────

  /**
   * Creates a ConversationActivity row and emits a socket event.
   * Call this from any service that changes conversation state.
   */
  async record(dto: CreateActivityDto): Promise<ActivityResponse> {
    const activity = await this.prisma.conversationActivity.create({
      data: {
        workspaceId:    dto.workspaceId,
        conversationId: dto.conversationId,
        eventType:      dto.eventType,
        actorId:        dto.actorId ?? null,
        actorType:      dto.actorType ?? (dto.actorId ? 'user' : 'system'),
        subjectUserId:  dto.subjectUserId ?? null,
        subjectTeamId:  dto.subjectTeamId ?? null,
        metadata:       dto.metadata ? (dto.metadata as any) : undefined,
      },
      include: {
        actor:       { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        subjectUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        subjectTeam: { select: { id: true, name: true } },
      },
    });

    const response = this.toResponse(activity);

    // Emit for real-time socket delivery
    this.events.emit('activity.upsert', {
      workspaceId:    dto.workspaceId,
      conversationId: dto.conversationId,
      activity:       response,
    });

    this.logger.debug(
      `Activity [${dto.eventType}] on conv ${dto.conversationId} by ${dto.actorId ?? 'system'}`,
    );

    return response;
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /** Returns all activities for a conversation ordered oldest-first */
  async findByConversation(conversationId: string): Promise<ActivityResponse[]> {
    const rows = await this.prisma.conversationActivity.findMany({
      where:   { conversationId },
      orderBy: { createdAt: 'asc' },
      include: {
        actor:       { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        subjectUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        subjectTeam: { select: { id: true, name: true } },
      },
    });

    return rows.map(r => this.toResponse(r));
  }

  // ─── Timeline (messages + activities merged) ──────────────────────────────

  /**
   * Returns a merged, time-sorted timeline of messages AND activities.
   * The FE renders messages as chat bubbles and activities as event pills.
   */
  async getTimeline(conversationId: string, workspaceId: string) {
    const [messages, activities] = await Promise.all([
      this.prisma.message.findMany({
        where:   { conversationId },
        orderBy: { createdAt: 'asc' },
        include: {
          author:             { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          messageAttachments: true,
        },
      }),
      this.findByConversation(conversationId),
    ]);

    // Build unified timeline items
    const items: any[] = [
      ...messages.map(m => ({
        id:        m.id,
        type:      'message' as const,
        timestamp: (m.sentAt ?? m.createdAt).toISOString(),
        message:   m,
      })),
      ...activities.map(a => ({
        id:        a.id,
        type:      'activity' as const,
        timestamp: a.createdAt,
        activity:  a,
      })),
    ];

    // Sort chronologically
    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return items;
  }

   toResponsePublic(row: any) {
    return this.toResponse(row);
  }
  // ─── Helpers ──────────────────────────────────────────────────────────────

  private toResponse(row: any): ActivityResponse {
    const actorName = row.actor
      ? `${row.actor.firstName ?? ''} ${row.actor.lastName ?? ''}`.trim()
      : null;

    return {
      id:             row.id,
      conversationId: row.conversationId,
      eventType:      row.eventType as ActivityEventType,
      actorType:      row.actorType,
      actor: row.actor
        ? {
            id:        row.actor.id,
            name:      actorName ?? 'Unknown',
            avatarUrl: row.actor.avatarUrl,
            type:      row.actorType,
          }
        : undefined,
      subjectUser: row.subjectUser
        ? {
            id:        row.subjectUser.id,
            name:      `${row.subjectUser.firstName ?? ''} ${row.subjectUser.lastName ?? ''}`.trim(),
            avatarUrl: row.subjectUser.avatarUrl,
          }
        : undefined,
      subjectTeam: row.subjectTeam
        ? { id: row.subjectTeam.id, name: row.subjectTeam.name }
        : undefined,
      metadata:    row.metadata,
      createdAt:   row.createdAt.toISOString(),
      description: this.describe(row.eventType, row, row.metadata),
    };
  }

  // ─── Human-readable descriptions ─────────────────────────────────────────

  private describe(eventType: string, row: any, meta: any): string {
    const actor = row.actor
      ? `${row.actor.firstName ?? ''} ${row.actor.lastName ?? ''}`.trim()
      : null;

    const by = actor ? ` by ${actor}` : '';

    switch (eventType) {
      case 'open':
        return actor
          ? `Conversation opened${by}`
          : `Conversation opened`;

      case 'close':
        return actor
          ? `Conversation closed${by}`
          : `Conversation closed`;

      case 'reopen':
        return actor
          ? `Conversation reopened${by}`
          : `Conversation reopened`;

      case 'pending':
        return actor
          ? `Conversation set to pending${by}`
          : `Conversation set to pending`;

      case 'assign_user': {
        const m = meta as AssignUserActivityMeta;
        if (!m?.previousUserId) {
          return `Assigned to ${m?.newUserName ?? 'someone'}${by}`;
        }
        return `Reassigned from ${m.previousUserName ?? 'previous agent'} to ${m.newUserName ?? 'new agent'}${by}`;
      }

      case 'unassign_user': {
        const m = meta as UnassignUserActivityMeta;
        return `${m?.previousUserName ?? 'Agent'} was unassigned${by}`;
      }

      case 'assign_team': {
        const m = meta as AssignTeamActivityMeta;
        if (!m?.previousTeamId) {
          return `Assigned to team ${m?.newTeamName ?? 'Unknown'}${by}`;
        }
        return `Team changed from ${m.previousTeamName} to ${m.newTeamName}${by}`;
      }

      case 'unassign_team': {
        const m = meta as UnassignTeamActivityMeta;
        return `Team ${m?.previousTeamName ?? 'Unknown'} was unassigned${by}`;
      }

      case 'merge_contact': {
        const m = meta as MergeContactActivityMeta;
        return `Contact merged with ${m?.mergedContactName ?? 'another contact'}${by}`;
      }

      case 'channel_added': {
        const m = meta as ChannelAddedActivityMeta;
        const ch = m?.channelType
          ? m.channelType.charAt(0).toUpperCase() + m.channelType.slice(1)
          : 'Channel';
        return `${ch} (${m?.identifier ?? ''}) added to contact${by}`;
      }

      case 'note': {
        const m = meta as NoteActivityMeta;
        const preview = m?.text
          ? (m.text.length > 60 ? m.text.slice(0, 60) + '…' : m.text)
          : '';
        return actor
          ? `${actor} left a note${preview ? ': ' + preview : ''}`
          : `Internal note added`;
      }

      case 'label_added': {
        const m = meta as any;
        return `Label "${m?.labelName ?? ''}" added${by}`;
      }

      case 'label_removed': {
        const m = meta as any;
        return `Label "${m?.labelName ?? ''}" removed${by}`;
      }

      case 'priority_changed': {
        const m = meta as PriorityChangedActivityMeta;
        return `Priority changed from ${m?.previousPriority ?? 'normal'} to ${m?.newPriority ?? 'normal'}${by}`;
      }

      case 'sla_breached': {
        const m = meta as any;
        return `SLA breached: ${m?.slaPolicy ?? 'policy'}`;
      }

      default:
        return eventType.replace(/_/g, ' ');
    }
  }
}