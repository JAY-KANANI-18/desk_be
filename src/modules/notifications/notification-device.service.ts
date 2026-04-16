import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RegisterNotificationDeviceDto,
  UnregisterNotificationDeviceDto,
} from './notification.dto';
import { NotificationPushService } from './notification-push.service';

@Injectable()
export class NotificationDeviceService {
  private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: NotificationPushService,
  ) {}

  getPushConfig() {
    const config = this.push.getPublicConfig();
    this.logDebug('push-config', config);
    return config;
  }

  async listForUser(userId: string) {
    const devices = await this.prisma.notificationDevice.findMany({
      where: { userId },
      orderBy: [
        { disabledAt: 'asc' },
        { invalidatedAt: 'asc' },
        { lastSeenAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        workspaceId: true,
        deviceKey: true,
        platform: true,
        deviceName: true,
        metadata: true,
        pushPermission: true,
        lastSeenAt: true,
        lastSuccessfulDeliveryAt: true,
        lastFailureAt: true,
        failureCount: true,
        invalidatedAt: true,
        disabledAt: true,
        disabledReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logDebug('list-for-user', {
      userId,
      count: devices.length,
      devices,
    });

    return devices;
  }

  async register(
    userId: string,
    workspaceId: string,
    body: RegisterNotificationDeviceDto,
  ) {
    const endpoint = body.subscription?.endpoint ?? body.token;
    const authSecret = body.subscription?.keys?.auth;
    const p256dhKey = body.subscription?.keys?.p256dh;

    if (!endpoint) {
      throw new BadRequestException('Device token or push subscription endpoint is required.');
    }

    const existing = await this.findExistingDevice(body.deviceKey, endpoint);
    const now = new Date();
    const subscriptionChanged =
      !existing ||
      existing.token !== endpoint ||
      existing.authSecret !== authSecret ||
      existing.p256dhKey !== p256dhKey;

    this.logDebug('register:start', {
      userId,
      workspaceId,
      platform: body.platform,
      deviceKey: body.deviceKey ?? null,
      endpoint,
      subscriptionChanged,
      hasExistingDevice: Boolean(existing),
      pushPermission: body.pushPermission ?? null,
      metadata: body.metadata ?? null,
    });

    const data = {
      userId,
      workspaceId,
      platform: body.platform,
      deviceKey: body.deviceKey ?? existing?.deviceKey ?? null,
      token: endpoint,
      authSecret: authSecret ?? existing?.authSecret ?? null,
      p256dhKey: p256dhKey ?? existing?.p256dhKey ?? null,
      expirationTime:
        body.subscription?.expirationTime != null
          ? new Date(body.subscription.expirationTime)
          : null,
      pushPermission: body.pushPermission ?? null,
      deviceName: body.deviceName ?? null,
      metadata: body.metadata
        ? (body.metadata as Prisma.InputJsonValue)
        : undefined,
      lastSeenAt: now,
      lastFailureAt: null,
      failureCount: 0,
      disabledAt: null,
      invalidatedAt: null,
      disabledReason: null,
      ...(subscriptionChanged ? { lastSubscriptionChangeAt: now } : {}),
    };

    if (existing) {
      const updated = await this.prisma.notificationDevice.update({
        where: { id: existing.id },
        data,
      });
      this.logDebug('register:updated', {
        userId,
        workspaceId,
        deviceId: updated.id,
        deviceKey: updated.deviceKey,
        endpoint: updated.token,
      });
      return updated;
    }

    const created = await this.prisma.notificationDevice.create({
      data,
    });
    this.logDebug('register:created', {
      userId,
      workspaceId,
      deviceId: created.id,
      deviceKey: created.deviceKey,
      endpoint: created.token,
    });
    return created;
  }

  async unregister(userId: string, body: UnregisterNotificationDeviceDto) {
    const filters = this.unregisterFilters(body);
    if (filters.length === 0) {
      throw new BadRequestException('deviceId, deviceKey, or token is required.');
    }

    await this.prisma.notificationDevice.updateMany({
      where: {
        userId,
        OR: filters,
      },
      data: {
        disabledAt: new Date(),
        disabledReason: body.reason ?? 'user-unregistered',
      },
    });

    this.logDebug('unregister', {
      userId,
      body,
      filters,
    });

    return { success: true };
  }

  async disableById(userId: string, deviceId: string, reason = 'user-disabled') {
    await this.prisma.notificationDevice.updateMany({
      where: {
        id: deviceId,
        userId,
      },
      data: {
        disabledAt: new Date(),
        disabledReason: reason,
      },
    });

    this.logDebug('disable-by-id', {
      userId,
      deviceId,
      reason,
    });

    return { success: true };
  }

  private async findExistingDevice(deviceKey?: string, endpoint?: string) {
    const filters: Prisma.NotificationDeviceWhereInput[] = [];

    if (deviceKey) {
      filters.push({ deviceKey });
    }

    if (endpoint) {
      filters.push({ token: endpoint });
    }

    if (filters.length === 0) {
      return null;
    }

    return this.prisma.notificationDevice.findFirst({
      where: {
        OR: filters,
      },
    });
  }

  private unregisterFilters(body: UnregisterNotificationDeviceDto) {
    const filters: Prisma.NotificationDeviceWhereInput[] = [];

    if (body.deviceId) {
      filters.push({ id: body.deviceId });
    }

    if (body.deviceKey) {
      filters.push({ deviceKey: body.deviceKey });
    }

    if (body.token) {
      filters.push({ token: body.token });
    }

    return filters;
  }

  private logDebug(event: string, details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    console.info(`[NotificationDebug][DeviceService] ${event}`, details ?? '');
  }
}
