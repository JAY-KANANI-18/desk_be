import { Worker } from 'bullmq';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { buildNotificationPushPayload } from '../modules/notifications/notification-routing';
import {
  NotificationPushService,
  WebPushSubscriptionPayload,
} from '../modules/notifications/notification-push.service';
import { renderEmailTemplate } from '../common/email/email-templates';
import { RedisService } from '../redis/redis.service';
import { connection } from './connection';

export class NotificationWorker {
  private transporter?: nodemailer.Transporter;
  private transporterVerified = false;
  private transporterVerifyPromise?: Promise<void>;
  private readonly push = new NotificationPushService();
  private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

  constructor(
    private redis: RedisService,
    private prisma: PrismaClient,
  ) {
    new Worker(
      'notification-queue',
      async (job) => {
        this.logDebug('job:received', {
          id: job.id,
          name: job.name,
          attemptsMade: job.attemptsMade,
          data: job.data,
        });

        if (job.name === 'send-email') {
          const { notificationId, email, subject, body } = job.data;
          await this.sendEmail(notificationId, email, subject, body);
        }

        if (job.name === 'send-push') {
          const { notificationId } = job.data;
          await this.sendPush(notificationId);
        }
      },
      {
        connection,
      },
    );
  }

  async sendEmail(notificationId: string, email: string, subject: string, body: string) {
    console.log('Sending email to:', email);

    try {
      const transporter = await this.getTransporter();
      const emailTemplate = renderEmailTemplate({
        template: 'notification',
        title: subject,
        body,
      });
      const result = await transporter.sendMail({
        from: this.getFromAddress(),
        to: email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
        text: emailTemplate.text,
      });
      console.log('Notification email accepted by SMTP:', {
        notificationId,
        email,
        messageId: result.messageId,
        response: result.response,
      });

      await this.markDelivery(
        notificationId,
        NotificationChannel.EMAIL,
        NotificationDeliveryStatus.SENT,
        undefined,
        result.messageId ?? null,
      );

      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
      });

      const contactId =
        typeof notification?.metadata === 'object' &&
        notification?.metadata &&
        'contactId' in (notification.metadata as Record<string, unknown>)
          ? String((notification.metadata as Record<string, unknown>).contactId)
          : null;

      if (notification?.workspaceId && contactId) {
        const activity = await this.prisma.userActivity.findUnique({
          where: { userId: notification.userId },
        });

        if (activity?.inactivitySessionId) {
          await this.prisma.notificationEmailHistory.upsert({
            where: {
              userId_contactId_type_inactivitySessionId: {
                userId: notification.userId,
                contactId,
                type: notification.type,
                inactivitySessionId: activity.inactivitySessionId,
              },
            },
            create: {
              notificationId,
              userId: notification.userId,
              workspaceId: notification.workspaceId,
              contactId,
              type: notification.type,
              inactivitySessionId: activity.inactivitySessionId,
            },
            update: {
              sentAt: new Date(),
            },
          });
        }
      }
    } catch (error) {
      console.error('Notification email failed:', {
        notificationId,
        email,
        error: error instanceof Error ? error.message : error,
      });
      await this.markDelivery(
        notificationId,
        NotificationChannel.EMAIL,
        NotificationDeliveryStatus.FAILED,
        error instanceof Error ? error.message : 'Unknown delivery error',
      );
      throw error;
    }
  }

  async sendPush(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        user: true,
        deliveries: true,
      },
    });

    if (!notification) {
      this.logDebug('push:notification-missing', {
        notificationId,
      });
      return;
    }

    const delivery = notification.deliveries.find(
      (item) => item.channel === NotificationChannel.MOBILE_PUSH,
    );

    if (!delivery) {
      this.logDebug('push:delivery-missing', {
        notificationId,
        availableDeliveries: notification.deliveries.map((item) => item.channel),
      });
      return;
    }

    if (!this.push.isConfigured()) {
      await this.markDelivery(
        notificationId,
        NotificationChannel.MOBILE_PUSH,
        NotificationDeliveryStatus.FAILED,
        'Web Push is not configured on the server.',
      );
      throw new Error('Web Push is not configured on the server.');
    }

    this.logDebug('push:start', {
      notificationId,
      notification: {
        id: notification.id,
        userId: notification.userId,
        workspaceId: notification.workspaceId ?? null,
        type: notification.type,
        title: notification.title,
        body: notification.body ?? '',
        metadata: this.asRecord(notification.metadata),
      },
      delivery,
    });

    const devices = await this.prisma.notificationDevice.findMany({
      where: {
        userId: notification.userId,
        disabledAt: null,
        invalidatedAt: null,
        authSecret: { not: null },
        p256dhKey: { not: null },
        ...(notification.workspaceId
          ? {
              OR: [
                { workspaceId: notification.workspaceId },
                { workspaceId: null },
              ],
            }
          : {}),
      },
      orderBy: [
        { lastSeenAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    this.logDebug('push:devices-selected', {
      notificationId,
      deviceCount: devices.length,
      devices: devices.map((device) => ({
        id: device.id,
        userId: device.userId,
        workspaceId: device.workspaceId ?? null,
        platform: device.platform,
        deviceName: device.deviceName ?? null,
        token: device.token,
        lastSeenAt: device.lastSeenAt,
        lastSuccessfulDeliveryAt: device.lastSuccessfulDeliveryAt,
        lastFailureAt: device.lastFailureAt,
        failureCount: device.failureCount,
        disabledAt: device.disabledAt,
        invalidatedAt: device.invalidatedAt,
      })),
    });

    if (devices.length === 0) {
      await this.updateDeliverySummary(delivery.id, {
        status: NotificationDeliveryStatus.SKIPPED,
        lastError: 'No active push subscriptions found for this user.',
        details: {
          targetCount: 0,
          sentCount: 0,
          failedCount: 0,
          invalidatedCount: 0,
          skippedCount: 0,
          reason: 'no-active-push-subscriptions',
        },
        completedAt: new Date(),
      });
      return;
    }

    let sentCount = 0;
    let failedCount = 0;
    let invalidatedCount = 0;
    let skippedCount = 0;

    const payload = buildNotificationPushPayload({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      metadata: this.asRecord(notification.metadata),
      workspaceId: notification.workspaceId,
      sourceEntityType: notification.sourceEntityType,
    });

    for (const device of devices) {
      const targetAttempt = await this.prisma.notificationDeliveryAttempt.upsert({
        where: {
          notificationDeliveryId_targetIdentifier: {
            notificationDeliveryId: delivery.id,
            targetIdentifier: device.token,
          },
        },
        create: {
          notificationDeliveryId: delivery.id,
          notificationDeviceId: device.id,
          targetIdentifier: device.token,
        },
        update: {
          notificationDeviceId: device.id,
        },
      });

      if (targetAttempt.status === NotificationDeliveryStatus.SENT) {
        this.logDebug('push:device-skipped-already-sent', {
          notificationId,
          deviceId: device.id,
          endpoint: device.token,
          attemptId: targetAttempt.id,
        });
        skippedCount += 1;
        continue;
      }

      try {
        this.logDebug('push:device-attempt', {
          notificationId,
          deviceId: device.id,
          endpoint: device.token,
          attemptId: targetAttempt.id,
          payload,
          deliveryOptions: {
            ttlSeconds: this.resolvePushTtlSeconds(notification.type),
            urgency: this.resolvePushUrgency(notification.type),
            topic: `notification-${notification.id}`,
          },
        });

        const response = await this.push.sendNotification(
          this.buildSubscription(device),
          payload,
          {
            ttlSeconds: this.resolvePushTtlSeconds(notification.type),
            urgency: this.resolvePushUrgency(notification.type),
            topic: `notification-${notification.id}`,
          },
        );

        if (response.ok) {
          this.logDebug('push:device-success', {
            notificationId,
            deviceId: device.id,
            endpoint: device.token,
            attemptId: targetAttempt.id,
            response,
          });
          sentCount += 1;
          await Promise.all([
            this.prisma.notificationDeliveryAttempt.update({
              where: { id: targetAttempt.id },
              data: {
                status: NotificationDeliveryStatus.SENT,
                attemptCount: { increment: 1 },
                providerStatusCode: response.status,
                lastError: null,
                lastAttemptAt: new Date(),
                deliveredAt: new Date(),
                invalidatedAt: null,
              },
            }),
            this.prisma.notificationDevice.update({
              where: { id: device.id },
              data: {
                lastSuccessfulDeliveryAt: new Date(),
                lastFailureAt: null,
                failureCount: 0,
                invalidatedAt: null,
                disabledReason: null,
              },
            }),
          ]);
          continue;
        }

        const responseBody = response.body || `Push service returned HTTP ${response.status}`;
        const invalidEndpoint = response.status === 404 || response.status === 410;

        failedCount += 1;
        if (invalidEndpoint) {
          invalidatedCount += 1;
        }

        this.logDebug('push:device-provider-failure', {
          notificationId,
          deviceId: device.id,
          endpoint: device.token,
          attemptId: targetAttempt.id,
          response,
          invalidEndpoint,
          responseBody,
        });

        await Promise.all([
          this.prisma.notificationDeliveryAttempt.update({
            where: { id: targetAttempt.id },
            data: {
              status: NotificationDeliveryStatus.FAILED,
              attemptCount: { increment: 1 },
              providerStatusCode: response.status,
              lastError: responseBody,
              lastAttemptAt: new Date(),
              invalidatedAt: invalidEndpoint ? new Date() : null,
            },
          }),
          this.prisma.notificationDevice.update({
            where: { id: device.id },
            data: {
              lastFailureAt: new Date(),
              failureCount: { increment: 1 },
              invalidatedAt: invalidEndpoint ? new Date() : null,
              disabledReason: invalidEndpoint ? 'push-endpoint-invalidated' : undefined,
            },
          }),
        ]);
      } catch (error) {
        failedCount += 1;
        this.logDebug('push:device-exception', {
          notificationId,
          deviceId: device.id,
          endpoint: device.token,
          attemptId: targetAttempt.id,
          error: error instanceof Error ? error.message : error,
        });
        await Promise.all([
          this.prisma.notificationDeliveryAttempt.update({
            where: { id: targetAttempt.id },
            data: {
              status: NotificationDeliveryStatus.FAILED,
              attemptCount: { increment: 1 },
              lastError: error instanceof Error ? error.message : 'Unknown push delivery error',
              lastAttemptAt: new Date(),
            },
          }),
          this.prisma.notificationDevice.update({
            where: { id: device.id },
            data: {
              lastFailureAt: new Date(),
              failureCount: { increment: 1 },
            },
          }),
        ]);
      }
    }

    const summary = {
      targetCount: devices.length,
      sentCount,
      failedCount,
      invalidatedCount,
      skippedCount,
    };

    this.logDebug('push:summary', {
      notificationId,
      deliveryId: delivery.id,
      summary,
    });

    if (failedCount > 0) {
      await this.updateDeliverySummary(delivery.id, {
        status: NotificationDeliveryStatus.FAILED,
        lastError: `${failedCount} push delivery target(s) failed.`,
        details: summary,
      });
      throw new Error(`${failedCount} push delivery target(s) failed.`);
    }

    await this.updateDeliverySummary(delivery.id, {
      status: NotificationDeliveryStatus.SENT,
      lastError: null,
      details: summary,
      completedAt: new Date(),
    });
  }

  private buildSubscription(device: {
    token: string;
    authSecret: string | null;
    p256dhKey: string | null;
    expirationTime: Date | null;
  }): WebPushSubscriptionPayload {
    if (!device.authSecret || !device.p256dhKey) {
      throw new Error('Notification device is missing push subscription keys.');
    }

    return {
      endpoint: device.token,
      expirationTime: device.expirationTime?.getTime() ?? null,
      keys: {
        auth: device.authSecret,
        p256dh: device.p256dhKey,
      },
    };
  }

  private async markDelivery(
    notificationId: string,
    channel: NotificationChannel,
    status: NotificationDeliveryStatus,
    lastError?: string,
    providerMessageId?: string | null,
  ) {
    await this.prisma.notificationDelivery.update({
      where: {
        notificationId_channel: {
          notificationId,
          channel,
        },
      },
      data: {
        status,
        lastError: status === NotificationDeliveryStatus.SENT ? null : lastError,
        providerMessageId: providerMessageId ?? undefined,
        attemptCount: {
          increment: 1,
        },
        lastAttemptAt: new Date(),
        ...(status === NotificationDeliveryStatus.SENT ||
        status === NotificationDeliveryStatus.SKIPPED
          ? { completedAt: new Date() }
          : {}),
      },
    });
  }

  private async updateDeliverySummary(
    deliveryId: string,
    input: {
      status: NotificationDeliveryStatus;
      lastError: string | null;
      details: Record<string, unknown>;
      completedAt?: Date;
    },
  ) {
    await this.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: input.status,
        lastError: input.lastError,
        details: input.details as Prisma.InputJsonValue,
        attemptCount: {
          increment: 1,
        },
        lastAttemptAt: new Date(),
        completedAt: input.completedAt,
      },
    });
  }

  private createTransport() {
    const host = process.env.NOTIFICATIONS_SMTP_HOST || process.env.SMTP_HOST;
    const port = Number(process.env.NOTIFICATIONS_SMTP_PORT || process.env.SMTP_PORT || 587);
    const user = process.env.NOTIFICATIONS_SMTP_USER || process.env.SMTP_USER;
    const pass = process.env.NOTIFICATIONS_SMTP_PASS || process.env.SMTP_PASS;
    const secure = String(process.env.NOTIFICATIONS_SMTP_SECURE || process.env.SMTP_SECURE || 'false') === 'true';

    if (!host || !user || !pass) {
      throw new Error('Notification email transport is not configured. Set NOTIFICATIONS_SMTP_HOST/USER/PASS or SMTP_HOST/USER/PASS.');
    }

    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
  }

  private async verifyTransporter(transporter: nodemailer.Transporter) {
    if (this.transporterVerified) {
      return;
    }

    if (!this.transporterVerifyPromise) {
      const host = process.env.NOTIFICATIONS_SMTP_HOST || process.env.SMTP_HOST;
      const port = Number(process.env.NOTIFICATIONS_SMTP_PORT || process.env.SMTP_PORT || 587);
      const secure = String(process.env.NOTIFICATIONS_SMTP_SECURE || process.env.SMTP_SECURE || 'false') === 'true';

      this.transporterVerifyPromise = transporter
        .verify()
        .then(() => {
          this.transporterVerified = true;
          console.log('Notification SMTP transporter verified', {
            host,
            port,
            secure,
            from: this.getFromAddress(),
          });
        })
        .catch((error) => {
          this.transporterVerifyPromise = undefined;
          console.error('Notification SMTP transporter verification failed', {
            host,
            port,
            secure,
            error: error instanceof Error ? error.message : error,
          });
          throw error;
        });
    }

    await this.transporterVerifyPromise;
  }

  private async getTransporter() {
    if (!this.transporter) {
      this.transporter = this.createTransport();
    }

    await this.verifyTransporter(this.transporter);
    return this.transporter;
  }

  private getFromAddress() {
    return (
      process.env.NOTIFICATIONS_EMAIL_FROM ||
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER
    );
  }

  private asRecord(value: Prisma.JsonValue | null) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private resolvePushUrgency(type: NotificationType) {
    switch (type) {
      case NotificationType.NEW_INCOMING_CALL:
      case NotificationType.NEW_INCOMING_MESSAGE:
      case NotificationType.CONTACT_ASSIGNED:
      case NotificationType.COMMENT_MENTION:
        return 'high' as const;
      case NotificationType.CUSTOM_NOTIFICATION:
        return 'normal' as const;
      case NotificationType.CONTACTS_IMPORT_COMPLETED:
      case NotificationType.DATA_EXPORT_READY:
      default:
        return 'low' as const;
    }
  }

  private resolvePushTtlSeconds(type: NotificationType) {
    switch (type) {
      case NotificationType.NEW_INCOMING_CALL:
        return 300;
      case NotificationType.NEW_INCOMING_MESSAGE:
      case NotificationType.CONTACT_ASSIGNED:
      case NotificationType.COMMENT_MENTION:
        return 900;
      case NotificationType.CUSTOM_NOTIFICATION:
        return 1800;
      case NotificationType.CONTACTS_IMPORT_COMPLETED:
      case NotificationType.DATA_EXPORT_READY:
      default:
        return 3600;
    }
  }

  private logDebug(event: string, details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    console.info(`[NotificationDebug][Worker] ${event}`, details ?? '');
  }
}
