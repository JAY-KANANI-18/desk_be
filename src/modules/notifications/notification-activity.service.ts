import { Injectable } from '@nestjs/common';
import { UserPresenceStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationActivityService {
  constructor(private prisma: PrismaService) {}

  async heartbeat(userId: string, workspaceId: string, module?: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { notificationInactivityTimeoutSec: true },
    });

    const existing = await this.prisma.userActivity.findUnique({
      where: { userId },
    });
    const now = new Date();
    const preservedManualState =
      existing?.activityStatus === UserPresenceStatus.AWAY ||
      existing?.activityStatus === UserPresenceStatus.BUSY ||
      existing?.activityStatus === UserPresenceStatus.DND
        ? existing.activityStatus
        : UserPresenceStatus.ACTIVE;

    const state = existing
      ? await this.prisma.userActivity.update({
          where: { userId },
          data: {
            activityStatus: preservedManualState,
            lastSeenAt: now,
            lastActivityAt: now,
            lastWorkspaceId: workspaceId,
          },
        })
      : await this.prisma.userActivity.create({
          data: {
            userId,
            activityStatus: UserPresenceStatus.ACTIVE,
            lastSeenAt: now,
            lastActivityAt: now,
            lastWorkspaceId: workspaceId,
          },
        });

    return {
      ...state,
      inactivityTimeoutSec: workspace?.notificationInactivityTimeoutSec ?? 300,
      module: module ?? null,
    };
  }

  async getEffectiveStatus(userId: string, workspaceId: string) {
    const [workspace, state] = await Promise.all([
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { notificationInactivityTimeoutSec: true },
      }),
      this.prisma.userActivity.findUnique({
        where: { userId },
      }),
    ]);

    const timeoutSec = workspace?.notificationInactivityTimeoutSec ?? 300;
    const now = Date.now();
    const lastActivityAt = state?.lastActivityAt?.getTime() ?? 0;
    const explicitState = state?.activityStatus ?? UserPresenceStatus.OFFLINE;

    if (
      explicitState === UserPresenceStatus.AWAY ||
      explicitState === UserPresenceStatus.BUSY ||
      explicitState === UserPresenceStatus.DND
    ) {
      return {
        status: explicitState,
        inactivitySessionId: state?.inactivitySessionId ?? null,
        timeoutSec,
      };
    }

    const isOffline =
      !lastActivityAt || now - lastActivityAt > timeoutSec * 1000;

    if (isOffline) {
      if (state && state.activityStatus !== UserPresenceStatus.OFFLINE) {
        const updated = await this.prisma.userActivity.update({
          where: { userId },
          data: {
            activityStatus: UserPresenceStatus.OFFLINE,
            inactivitySessionId: crypto.randomUUID(),
          },
        });

        return {
          status: updated.activityStatus,
          inactivitySessionId: updated.inactivitySessionId,
          timeoutSec,
        };
      }

      return {
        status: UserPresenceStatus.OFFLINE,
        inactivitySessionId: state?.inactivitySessionId ?? null,
        timeoutSec,
      };
    }

    if (!state) {
      const created = await this.prisma.userActivity.create({
        data: {
          userId,
          activityStatus: UserPresenceStatus.ACTIVE,
          lastSeenAt: new Date(),
          lastActivityAt: new Date(),
          lastWorkspaceId: workspaceId,
        },
      });

      return {
        status: created.activityStatus,
        inactivitySessionId: created.inactivitySessionId,
        timeoutSec,
      };
    }

    return {
      status: UserPresenceStatus.ACTIVE,
      inactivitySessionId: state.inactivitySessionId,
      timeoutSec,
    };
  }

  async updateInactivityTimeout(workspaceId: string, inactivityTimeoutSec: number) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { notificationInactivityTimeoutSec: inactivityTimeoutSec },
      select: {
        id: true,
        notificationInactivityTimeoutSec: true,
      },
    });
  }
}
