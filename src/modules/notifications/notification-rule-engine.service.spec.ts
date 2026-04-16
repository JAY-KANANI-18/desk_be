import {
  NotificationContactScope,
  NotificationType,
  SoundNotificationScope,
  CallSoundNotificationScope,
  UserPresenceStatus,
} from '@prisma/client';

jest.mock('../../realtime/realtime.service', () => ({
  RealtimeService: class RealtimeService {},
}));

import { NotificationRuleEngineService } from './notification-rule-engine.service';

describe('NotificationRuleEngineService', () => {
  const preferences = {
    getUserPreferences: jest.fn(),
  };

  const activity = {
    getEffectiveStatus: jest.fn(),
  };

  const prisma = {
    notificationEmailHistory: {
      findFirst: jest.fn(),
    },
  };

  const realtime = {
    hasUserConnection: jest.fn(),
  };

  let service: NotificationRuleEngineService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationRuleEngineService(
      prisma as any,
      preferences as any,
      activity as any,
      realtime as any,
    );
  });

  it('suppresses mobile notifications when the user has an active realtime session', async () => {
    preferences.getUserPreferences.mockResolvedValue({
      desktopScope: NotificationContactScope.ALL_CONTACTS,
      mobileScope: NotificationContactScope.ALL_CONTACTS,
      emailScope: NotificationContactScope.ALL_CONTACTS,
      soundScope: SoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
      callSoundScope: CallSoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
    });
    activity.getEffectiveStatus.mockResolvedValue({
      status: UserPresenceStatus.ACTIVE,
      inactivitySessionId: 'session-1',
    });
    realtime.hasUserConnection.mockResolvedValue(true);

    const decisions = await service.evaluate(
      'user-1',
      'workspace-1',
      NotificationType.NEW_INCOMING_MESSAGE,
      { assigneeId: 'user-1', contactId: 'contact-1' },
    );

    expect(
      decisions.find((item) => item.channel === 'MOBILE_PUSH')?.shouldSend,
    ).toBe(false);
  });

  it('sends mention notifications to background channels for mentioned users with no active session', async () => {
    preferences.getUserPreferences.mockResolvedValue({
      desktopScope: NotificationContactScope.MENTIONS_ONLY,
      mobileScope: NotificationContactScope.MENTIONS_ONLY,
      emailScope: NotificationContactScope.MENTIONS_ONLY,
      soundScope: SoundNotificationScope.ASSIGNED_ONLY,
      callSoundScope: CallSoundNotificationScope.ASSIGNED_ONLY,
    });
    activity.getEffectiveStatus.mockResolvedValue({
      status: UserPresenceStatus.OFFLINE,
      inactivitySessionId: 'session-2',
    });
    realtime.hasUserConnection.mockResolvedValue(false);

    const decisions = await service.evaluate(
      'user-2',
      'workspace-1',
      NotificationType.COMMENT_MENTION,
      { mentionedUserIds: ['user-2'] },
    );

    expect(
      decisions.find((item) => item.channel === 'MOBILE_PUSH')?.shouldSend,
    ).toBe(true);
    expect(
      decisions.find((item) => item.channel === 'EMAIL')?.shouldSend,
    ).toBe(true);
  });

  it('suppresses duplicate incoming-message emails during the same inactivity session', async () => {
    preferences.getUserPreferences.mockResolvedValue({
      desktopScope: NotificationContactScope.ALL_CONTACTS,
      mobileScope: NotificationContactScope.ALL_CONTACTS,
      emailScope: NotificationContactScope.ALL_CONTACTS,
      soundScope: SoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
      callSoundScope: CallSoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
    });
    activity.getEffectiveStatus.mockResolvedValue({
      status: UserPresenceStatus.OFFLINE,
      inactivitySessionId: 'session-3',
    });
    prisma.notificationEmailHistory.findFirst.mockResolvedValue({
      id: 'history-1',
    });
    realtime.hasUserConnection.mockResolvedValue(false);

    const decisions = await service.evaluate(
      'user-1',
      'workspace-1',
      NotificationType.NEW_INCOMING_MESSAGE,
      { assigneeId: 'user-1', contactId: 'contact-9' },
    );

    expect(
      decisions.find((item) => item.channel === 'EMAIL')?.shouldSend,
    ).toBe(false);
  });

  it('allows background push immediately when the user has no live session', async () => {
    preferences.getUserPreferences.mockResolvedValue({
      desktopScope: NotificationContactScope.ALL_CONTACTS,
      mobileScope: NotificationContactScope.ALL_CONTACTS,
      emailScope: NotificationContactScope.ALL_CONTACTS,
      soundScope: SoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
      callSoundScope: CallSoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
    });
    activity.getEffectiveStatus.mockResolvedValue({
      status: UserPresenceStatus.ACTIVE,
      inactivitySessionId: 'session-4',
    });
    realtime.hasUserConnection.mockResolvedValue(false);

    const decisions = await service.evaluate(
      'user-1',
      'workspace-1',
      NotificationType.CONTACT_ASSIGNED,
      { assigneeId: 'user-1', contactId: 'contact-4' },
    );

    expect(
      decisions.find((item) => item.channel === 'MOBILE_PUSH')?.shouldSend,
    ).toBe(true);
  });

  it('allows background push when the user is explicitly offline even if a socket is still connected', async () => {
    preferences.getUserPreferences.mockResolvedValue({
      desktopScope: NotificationContactScope.ALL_CONTACTS,
      mobileScope: NotificationContactScope.ALL_CONTACTS,
      emailScope: NotificationContactScope.ALL_CONTACTS,
      soundScope: SoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
      callSoundScope: CallSoundNotificationScope.ASSIGNED_AND_UNASSIGNED,
    });
    activity.getEffectiveStatus.mockResolvedValue({
      status: UserPresenceStatus.OFFLINE,
      inactivitySessionId: 'session-5',
    });
    realtime.hasUserConnection.mockResolvedValue(true);

    const decisions = await service.evaluate(
      'user-1',
      'workspace-1',
      NotificationType.NEW_INCOMING_MESSAGE,
      { assigneeId: 'user-1', contactId: 'contact-7' },
    );

    expect(
      decisions.find((item) => item.channel === 'MOBILE_PUSH')?.shouldSend,
    ).toBe(true);
    expect(
      decisions.find((item) => item.channel === 'IN_APP')?.shouldSend,
    ).toBe(false);
  });
});
