import { Injectable } from '@nestjs/common';
import { UserPresenceStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationActivityService {
  private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

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
    const preservedManualState = this.getPreservedManualState(existing?.activityStatus);

    this.logDebug('heartbeat:start', {
      userId,
      workspaceId,
      module: module ?? null,
      existing,
      workspace,
    });

    if (module === 'background') {
      const nextStatus = preservedManualState ?? UserPresenceStatus.OFFLINE;
      const rotateInactivitySession =
        nextStatus === UserPresenceStatus.OFFLINE &&
        existing?.activityStatus !== UserPresenceStatus.OFFLINE;

      const state = existing
        ? await this.prisma.userActivity.update({
            where: { userId },
            data: {
              activityStatus: nextStatus,
              lastSeenAt: now,
              lastWorkspaceId: workspaceId,
              ...(rotateInactivitySession
                ? { inactivitySessionId: crypto.randomUUID() }
                : {}),
            },
          })
        : await this.prisma.userActivity.create({
            data: {
              userId,
              activityStatus: nextStatus,
              lastSeenAt: now,
              lastWorkspaceId: workspaceId,
            },
          });

      this.logDebug('heartbeat:background', {
        userId,
        workspaceId,
        nextStatus,
        rotateInactivitySession,
        state,
      });

      return {
        ...state,
        inactivityTimeoutSec: workspace?.notificationInactivityTimeoutSec ?? 300,
        module: module ?? null,
      };
    }

    const state = existing
      ? await this.prisma.userActivity.update({
          where: { userId },
          data: {
            activityStatus: preservedManualState ?? UserPresenceStatus.ACTIVE,
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

    this.logDebug('heartbeat:active', {
      userId,
      workspaceId,
      state,
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

    this.logDebug('effective-status:start', {
      userId,
      workspaceId,
      workspace,
      state,
      timeoutSec,
    });

    if (explicitState === UserPresenceStatus.OFFLINE) {
      this.logDebug('effective-status:explicit-offline', {
        userId,
        workspaceId,
        timeoutSec,
        inactivitySessionId: state?.inactivitySessionId ?? null,
      });
      return {
        status: UserPresenceStatus.OFFLINE,
        inactivitySessionId: state?.inactivitySessionId ?? null,
        timeoutSec,
      };
    }

    if (
      explicitState === UserPresenceStatus.AWAY ||
      explicitState === UserPresenceStatus.BUSY ||
      explicitState === UserPresenceStatus.DND
    ) {
      this.logDebug('effective-status:manual-status', {
        userId,
        workspaceId,
        explicitState,
        timeoutSec,
      });
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

        this.logDebug('effective-status:timeout-updated-offline', {
          userId,
          workspaceId,
          timeoutSec,
          updated,
        });

        return {
          status: updated.activityStatus,
          inactivitySessionId: updated.inactivitySessionId,
          timeoutSec,
        };
      }

      this.logDebug('effective-status:timeout-offline', {
        userId,
        workspaceId,
        timeoutSec,
        inactivitySessionId: state?.inactivitySessionId ?? null,
      });

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

      this.logDebug('effective-status:created-active', {
        userId,
        workspaceId,
        timeoutSec,
        created,
      });

      return {
        status: created.activityStatus,
        inactivitySessionId: created.inactivitySessionId,
        timeoutSec,
      };
    }

    this.logDebug('effective-status:active', {
      userId,
      workspaceId,
      timeoutSec,
      inactivitySessionId: state.inactivitySessionId,
    });

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

  private getPreservedManualState(status?: UserPresenceStatus | null) {
    return status === UserPresenceStatus.AWAY ||
      status === UserPresenceStatus.BUSY ||
      status === UserPresenceStatus.DND
      ? status
      : null;
  }

  private logDebug(event: string, details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    console.info(`[NotificationDebug][Activity] ${event}`, details ?? '');
  }
}
