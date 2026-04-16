import { UserPresenceStatus } from '@prisma/client';
import { NotificationActivityService } from './notification-activity.service';

describe('NotificationActivityService', () => {
  const prisma = {
    workspace: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    userActivity: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
  };

  let service: NotificationActivityService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationActivityService(prisma as any);
  });

  it('marks stale users offline after the workspace timeout', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      notificationInactivityTimeoutSec: 300,
    });
    prisma.userActivity.findUnique.mockResolvedValue({
      userId: 'user-1',
      activityStatus: UserPresenceStatus.ACTIVE,
      lastActivityAt: new Date(Date.now() - 360_000),
      inactivitySessionId: 'old-session',
    });
    prisma.userActivity.update.mockResolvedValue({
      activityStatus: UserPresenceStatus.OFFLINE,
      inactivitySessionId: 'new-session',
    });

    const result = await service.getEffectiveStatus('user-1', 'workspace-1');

    expect(result.status).toBe(UserPresenceStatus.OFFLINE);
    expect(prisma.userActivity.update).toHaveBeenCalled();
  });

  it('keeps active users active within the timeout window', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      notificationInactivityTimeoutSec: 300,
    });
    prisma.userActivity.findUnique.mockResolvedValue({
      userId: 'user-2',
      activityStatus: UserPresenceStatus.ACTIVE,
      lastActivityAt: new Date(),
      inactivitySessionId: 'session-1',
    });

    const result = await service.getEffectiveStatus('user-2', 'workspace-1');

    expect(result.status).toBe(UserPresenceStatus.ACTIVE);
    expect(prisma.userActivity.update).not.toHaveBeenCalled();
  });

  it('marks the session offline immediately when the app moves to the background', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      notificationInactivityTimeoutSec: 300,
    });
    prisma.userActivity.findUnique.mockResolvedValue({
      userId: 'user-3',
      activityStatus: UserPresenceStatus.ACTIVE,
      lastActivityAt: new Date(),
      inactivitySessionId: 'session-2',
    });
    prisma.userActivity.update.mockResolvedValue({
      userId: 'user-3',
      activityStatus: UserPresenceStatus.OFFLINE,
      inactivitySessionId: 'session-3',
    });

    const result = await service.heartbeat('user-3', 'workspace-1', 'background');

    expect(result.activityStatus).toBe(UserPresenceStatus.OFFLINE);
    expect(prisma.userActivity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-3' },
        data: expect.objectContaining({
          activityStatus: UserPresenceStatus.OFFLINE,
        }),
      }),
    );
  });

  it('respects an explicit offline status even if the last activity timestamp is recent', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      notificationInactivityTimeoutSec: 300,
    });
    prisma.userActivity.findUnique.mockResolvedValue({
      userId: 'user-4',
      activityStatus: UserPresenceStatus.OFFLINE,
      lastActivityAt: new Date(),
      inactivitySessionId: 'session-4',
    });

    const result = await service.getEffectiveStatus('user-4', 'workspace-1');

    expect(result.status).toBe(UserPresenceStatus.OFFLINE);
    expect(prisma.userActivity.update).not.toHaveBeenCalled();
  });
});
