import { Injectable, NotFoundException } from '@nestjs/common';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationQueue } from 'src/queues/notification.queue';
import {
  CreateCustomNotificationDto,
  IngestNotificationEventDto,
} from './notification.dto';
import { NotificationActivityService } from './notification-activity.service';
import { NotificationRuleEngineService } from './notification-rule-engine.service';
import { NotificationEventInput } from './notification.types';

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private notificationQueue: NotificationQueue,
    private activity: NotificationActivityService,
    private rules: NotificationRuleEngineService,
  ) {}

  async ingest(input: NotificationEventInput) {
    if (input.dedupeKey) {
      const existing = await this.prisma.notification.findFirst({
        where: {
          userId: input.userId,
          dedupeKey: input.dedupeKey,
        },
        include: {
          deliveries: true,
        },
      });

      if (existing) {
        return existing;
      }
    }

    const decisions = await this.rules.evaluate(
      input.userId,
      input.workspaceId,
      input.type,
      input.target,
    );

    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        organizationId: input.organizationId ?? undefined,
        type: input.type,
        title: input.title,
        body: input.body ?? undefined,
        metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
        sourceEntityType: input.sourceEntityType ?? undefined,
        sourceEntityId: input.sourceEntityId ?? undefined,
        dedupeKey: input.dedupeKey ?? undefined,
        deliveries: {
          create: decisions.map((decision) => ({
            userId: input.userId,
            channel: decision.channel,
            status: decision.shouldSend
              ? NotificationDeliveryStatus.PENDING
              : NotificationDeliveryStatus.SUPPRESSED,
            lastError: decision.reason,
          })),
        },
      },
      include: {
        deliveries: true,
      },
    });

    await this.dispatchChannels(notification.id);

    const unreadCount = await this.prisma.notification.count({
      where: {
        userId: input.userId,
        readAt: null,
        archivedAt: null,
      },
    });

    this.realtime.emitToUser(input.userId, 'notification:new', {
      notification,
      unreadCount,
    });

    return notification;
  }

  async ingestFromDto(dto: IngestNotificationEventDto, workspaceId: string, organizationId?: string) {
    return this.ingest({
      userId: dto.userId,
      workspaceId,
      organizationId,
      type: dto.type,
      title: dto.title,
      body: dto.body,
      metadata: dto.metadata,
      sourceEntityType: dto.sourceEntityType,
      sourceEntityId: dto.sourceEntityId,
      dedupeKey: dto.dedupeKey,
      target: {
        assigneeId: dto.assigneeId,
        contactId: dto.contactId,
        conversationId: dto.conversationId,
      },
    });
  }

  async createCustom(dto: CreateCustomNotificationDto, workspaceId: string, organizationId?: string) {
    return Promise.all(
      dto.userIds.map((userId) =>
        this.ingest({
          userId,
          workspaceId,
          organizationId,
          type: NotificationType.CUSTOM_NOTIFICATION,
          title: dto.title,
          body: dto.body,
          metadata: dto.metadata,
          sourceEntityType: dto.sourceEntityType,
          sourceEntityId: dto.sourceEntityId,
          dedupeKey: dto.dedupeKey ? `${dto.dedupeKey}:${userId}` : null,
        }),
      ),
    );
  }

  async listForUser(userId: string, workspaceId: string, tab: 'new' | 'archived' | 'all', limit = 20, cursor?: string) {
    const items = await this.prisma.notification.findMany({
      where: {
        userId,
        workspaceId,
        ...(tab === 'new'
          ? { readAt: null, archivedAt: null }
          : tab === 'archived'
            ? { archivedAt: { not: null } }
            : {}),
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? data[data.length - 1]?.createdAt.toISOString() : null;

    return { items: data, nextCursor };
  }

  async getUnreadCount(userId: string, workspaceId: string) {
    return this.prisma.notification.count({
      where: {
        userId,
        workspaceId,
        readAt: null,
        archivedAt: null,
      },
    });
  }

  async markState(userId: string, notificationId: string, state: { read?: boolean; archived?: boolean }) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        ...(state.read !== undefined
          ? { readAt: state.read ? new Date() : null }
          : {}),
        ...(state.archived !== undefined
          ? { archivedAt: state.archived ? new Date() : null }
          : {}),
      },
    });

    await this.broadcastBadge(userId, notification.workspaceId ?? undefined);
    this.realtime.emitToUser(userId, 'notification:updated', updated);
    return updated;
  }

  async markAllRead(userId: string, workspaceId: string) {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        workspaceId,
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    await this.broadcastBadge(userId, workspaceId);
    return { success: true };
  }

  async archiveAll(userId: string, workspaceId: string, tab: 'new' | 'archived' | 'all') {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        workspaceId,
        ...(tab === 'archived' ? { archivedAt: { not: null } } : { archivedAt: null }),
        ...(tab === 'new' ? { readAt: null } : {}),
      },
      data: { archivedAt: new Date() },
    });

    await this.broadcastBadge(userId, workspaceId);
    return { success: true };
  }

  async registerEmailHistory(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: { user: true },
    });

    if (!notification || !notification.workspaceId) {
      return;
    }

    const status = await this.activity.getEffectiveStatus(
      notification.userId,
      notification.workspaceId,
    );
    const metadata = (notification.metadata ?? {}) as Record<string, unknown>;
    const contactId = typeof metadata.contactId === 'string' ? metadata.contactId : null;

    if (!contactId || !status.inactivitySessionId) {
      return;
    }

    await this.prisma.notificationEmailHistory.upsert({
      where: {
        userId_contactId_type_inactivitySessionId: {
          userId: notification.userId,
          contactId,
          type: notification.type,
          inactivitySessionId: status.inactivitySessionId,
        },
      },
      create: {
        notificationId,
        userId: notification.userId,
        workspaceId: notification.workspaceId,
        contactId,
        type: notification.type,
        inactivitySessionId: status.inactivitySessionId,
      },
      update: {
        notificationId,
        sentAt: new Date(),
      },
    });
  }

  private async dispatchChannels(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        deliveries: true,
        user: true,
      },
    });

    if (!notification) {
      return;
    }

    for (const delivery of notification.deliveries) {
      if (delivery.status !== NotificationDeliveryStatus.PENDING) {
        continue;
      }

      if (delivery.channel === NotificationChannel.IN_APP) {
        await this.prisma.notificationDelivery.update({
          where: { notificationId_channel: { notificationId, channel: delivery.channel } },
          data: {
            status: NotificationDeliveryStatus.SENT,
            attemptCount: { increment: 1 },
            lastAttemptAt: new Date(),
          },
        });
        continue;
      }

      if (delivery.channel === NotificationChannel.EMAIL) {
        await this.notificationQueue.addEmailNotification({
          notificationId,
          email: notification.user.email,
          subject: notification.title,
          body: notification.body ?? '',
        });
        continue;
      }

      if (delivery.channel === NotificationChannel.MOBILE_PUSH) {
        await this.notificationQueue.addPushNotification({
          notificationId,
          userId: notification.userId,
          title: notification.title,
          body: notification.body ?? '',
          metadata: (notification.metadata ?? {}) as Record<string, unknown>,
        });
        continue;
      }

      await this.prisma.notificationDelivery.update({
        where: { notificationId_channel: { notificationId, channel: delivery.channel } },
        data: {
          status: NotificationDeliveryStatus.SENT,
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
        },
      });
    }
  }

  private async broadcastBadge(userId: string, workspaceId?: string) {
    if (!workspaceId) {
      return;
    }

    const unreadCount = await this.getUnreadCount(userId, workspaceId);
    this.realtime.emitToUser(userId, 'notification:badge', { unreadCount, workspaceId });
  }
}
