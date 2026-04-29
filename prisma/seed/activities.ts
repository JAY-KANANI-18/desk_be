import { NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  batchInsert,
  dateInRange,
  getFaker,
  randBetween,
  weightedPick,
} from './helpers';
import type {
  SeedConversationsResult,
  SeededConversation,
} from './conversations';
import type { SeedUsersResult } from './users';

export type SeedActivitiesDeps = SeedUsersResult &
  SeedConversationsResult & {
    prisma: PrismaClient;
  };

export type SeedActivitiesResult = {
  activityCount: number;
  notificationIds: string[];
};

type ActivityCandidate = Omit<
  Prisma.ConversationActivityCreateManyInput,
  'id' | 'workspaceId' | 'conversationId' | 'createdAt'
> & {
  createdAt: Date;
};

function randomActor(agentIds: string[]): string {
  return agentIds[randBetween(0, agentIds.length - 1)];
}

function buildActivityCandidates(
  conversation: SeededConversation,
  agentIds: string[],
): ActivityCandidate[] {
  const faker = getFaker();
  const candidates: ActivityCandidate[] = [
    {
      eventType: 'conversation_opened',
      actorId: null,
      actorType: 'system',
      subjectUserId: null,
      subjectTeamId: null,
      metadata: {
        channelType: conversation.channelType,
      },
      createdAt: conversation.createdAt,
    },
  ];

  if (conversation.assigneeId) {
    candidates.push({
      eventType: 'assigned_user',
      actorId: randomActor(agentIds),
      actorType: 'user',
      subjectUserId: conversation.assigneeId,
      subjectTeamId: null,
      metadata: {
        assignmentSource: weightedPick([
          { value: 'manual', weight: 60 },
          { value: 'round_robin', weight: 30 },
          { value: 'workflow', weight: 10 },
        ]),
      },
      createdAt: dateInRange(
        conversation.createdAt,
        conversation.lastMessageAt,
      ),
    });
  }

  if (conversation.teamId) {
    candidates.push({
      eventType: 'assigned_team',
      actorId: conversation.assigneeId ?? null,
      actorType: conversation.assigneeId ? 'user' : 'system',
      subjectUserId: null,
      subjectTeamId: conversation.teamId,
      metadata: {
        assignmentSource: 'routing_rule',
      },
      createdAt: dateInRange(
        conversation.createdAt,
        conversation.lastMessageAt,
      ),
    });
  }

  if (conversation.priority !== 'normal') {
    candidates.push({
      eventType: 'priority_changed',
      actorId: conversation.assigneeId ?? randomActor(agentIds),
      actorType: 'user',
      subjectUserId: null,
      subjectTeamId: null,
      metadata: {
        from: 'normal',
        to: conversation.priority,
      },
      createdAt: dateInRange(
        conversation.createdAt,
        conversation.lastMessageAt,
      ),
    });
  }

  if (conversation.status === 'pending') {
    candidates.push({
      eventType: 'conversation_pending',
      actorId: conversation.assigneeId ?? randomActor(agentIds),
      actorType: 'user',
      subjectUserId: null,
      subjectTeamId: null,
      metadata: {
        reason: weightedPick([
          { value: 'waiting_for_customer', weight: 55 },
          { value: 'waiting_for_internal_team', weight: 30 },
          { value: 'waiting_for_provider', weight: 15 },
        ]),
      },
      createdAt: dateInRange(
        conversation.createdAt,
        conversation.lastMessageAt,
      ),
    });
  }

  if (conversation.status === 'resolved') {
    candidates.push({
      eventType: 'conversation_resolved',
      actorId: conversation.assigneeId ?? randomActor(agentIds),
      actorType: 'user',
      subjectUserId: null,
      subjectTeamId: null,
      metadata: {
        resolution: weightedPick([
          { value: 'answered', weight: 45 },
          { value: 'fixed', weight: 25 },
          { value: 'no_reply_needed', weight: 20 },
          { value: 'duplicate', weight: 10 },
        ]),
      },
      createdAt: conversation.lastMessageAt,
    });
  }

  if (Math.random() < 0.35) {
    candidates.push({
      eventType: 'internal_note_added',
      actorId: conversation.assigneeId ?? randomActor(agentIds),
      actorType: 'user',
      subjectUserId: null,
      subjectTeamId: null,
      metadata: {
        preview: faker.lorem.sentence(),
      },
      createdAt: dateInRange(
        conversation.createdAt,
        conversation.lastMessageAt,
      ),
    });
  }

  return candidates.sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  );
}

export async function seedActivities({
  prisma,
  workspaceId,
  organizationId,
  agentIds,
  conversations,
}: SeedActivitiesDeps): Promise<SeedActivitiesResult> {
  const faker = getFaker();
  const activityRows: Prisma.ConversationActivityCreateManyInput[] = [];
  const notificationRows: Prisma.NotificationCreateManyInput[] = [];
  const notificationIds: string[] = [];

  conversations.forEach((conversation) => {
    const activityTargetCount = randBetween(1, 3);
    const candidates = buildActivityCandidates(conversation, agentIds);

    candidates.slice(0, activityTargetCount).forEach((candidate) => {
      activityRows.push({
        id: randomUUID(),
        workspaceId,
        conversationId: conversation.id,
        ...candidate,
      });
    });

    const shouldNotify =
      conversation.status === 'open'
        ? Math.random() < 0.28
        : conversation.status === 'pending'
          ? Math.random() < 0.16
          : Math.random() < 0.05;

    if (shouldNotify) {
      const id = randomUUID();
      const userId = conversation.assigneeId ?? randomActor(agentIds);
      const createdAt = dateInRange(
        conversation.createdAt,
        conversation.lastMessageAt,
      );
      const type =
        conversation.assigneeId && Math.random() < 0.25
          ? NotificationType.CONTACT_ASSIGNED
          : NotificationType.NEW_INCOMING_MESSAGE;

      notificationIds.push(id);
      notificationRows.push({
        id,
        userId,
        workspaceId,
        organizationId,
        type,
        title:
          type === NotificationType.CONTACT_ASSIGNED
            ? 'Contact assigned'
            : 'New incoming message',
        body:
          type === NotificationType.CONTACT_ASSIGNED
            ? 'A contact was assigned for follow-up.'
            : faker.lorem.sentence(),
        metadata: {
          seeded: true,
          priority: conversation.priority,
          channelType: conversation.channelType,
        },
        sourceEntityType: 'conversation',
        sourceEntityId: conversation.id,
        dedupeKey: `seed:${type}:${conversation.id}`,
        readAt:
          Math.random() < 0.62 ? dateInRange(createdAt, new Date()) : null,
        archivedAt: null,
        createdAt,
      });
    }
  });

  await batchInsert<Prisma.ConversationActivityCreateManyInput>(
    prisma.conversationActivity,
    activityRows,
  );
  await batchInsert<Prisma.NotificationCreateManyInput>(
    prisma.notification,
    notificationRows,
  );

  return {
    activityCount: activityRows.length,
    notificationIds,
  };
}
