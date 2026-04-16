import { Injectable } from '@nestjs/common';
import {
  CallSoundNotificationScope,
  NotificationChannel,
  NotificationContactScope,
  NotificationType,
  SoundNotificationScope,
  UserPresenceStatus,
} from '@prisma/client';
import { NotificationActivityService } from './notification-activity.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  DESKTOP_DEFAULTS,
  EMAIL_DEFAULTS,
  MOBILE_DEFAULTS,
  NOTIFICATION_CENTER_DEFAULTS,
  NotificationActorTarget,
  NotificationDeliveryDecision,
} from './notification.types';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';

@Injectable()
export class NotificationRuleEngineService {
  private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

  constructor(
    private prisma: PrismaService,
    private preferences: NotificationPreferencesService,
    private activity: NotificationActivityService,
    private realtime: RealtimeService,
  ) {}

  async evaluate(
    userId: string,
    workspaceId: string,
    type: NotificationType,
    target?: NotificationActorTarget,
  ): Promise<NotificationDeliveryDecision[]> {
    const [prefs, activity, hasLiveSession] = await Promise.all([
      this.preferences.getUserPreferences(userId, workspaceId),
      this.activity.getEffectiveStatus(userId, workspaceId),
      this.realtime.hasUserConnection(userId),
    ]);
    const hasForegroundSession =
      hasLiveSession && activity.status !== UserPresenceStatus.OFFLINE;

    const inApp = NOTIFICATION_CENTER_DEFAULTS[type];
    const desktop = DESKTOP_DEFAULTS[type];
    const mobile = MOBILE_DEFAULTS[type];
    const email = EMAIL_DEFAULTS[type];

    const decisions: NotificationDeliveryDecision[] = [];

    decisions.push({
      channel: NotificationChannel.IN_APP,
      shouldSend: inApp && hasForegroundSession,
      reason: !inApp ? 'matrix-disabled' : hasForegroundSession ? 'active-session' : 'no-active-session',
    });

    decisions.push({
      channel: NotificationChannel.DESKTOP,
      shouldSend:
        desktop &&
        hasForegroundSession &&
        this.matchesContactScope(prefs.desktopScope, type, userId, target),
      reason:
        !desktop
          ? 'matrix-disabled'
          : hasForegroundSession
            ? 'preference-scope'
            : 'no-active-session',
    });

    const shouldSendBackgroundPush =
      mobile &&
      !hasForegroundSession &&
      this.matchesPushRules(activity.status) &&
      this.matchesContactScope(prefs.mobileScope, type, userId, target);

    decisions.push({
      channel: NotificationChannel.MOBILE_PUSH,
      shouldSend: shouldSendBackgroundPush,
      reason:
        !mobile
          ? 'matrix-disabled'
          : hasForegroundSession
            ? 'active-session'
            : activity.status === UserPresenceStatus.DND ||
                activity.status === UserPresenceStatus.BUSY
              ? 'manual-presence-suppressed'
              : 'background-preference-scope',
    });

    const emailEligible =
      email &&
      this.matchesContactScope(prefs.emailScope, type, userId, target) &&
      this.matchesEmailRules(type, activity.status);

    let emailReason = email ? 'preference-scope' : 'matrix-disabled';
    if (email && activity.status !== UserPresenceStatus.OFFLINE) {
      emailReason = 'user-active';
    }

    if (
      emailEligible &&
      type === NotificationType.NEW_INCOMING_MESSAGE &&
      target?.contactId &&
      activity.inactivitySessionId
    ) {
      const alreadySent = await this.prisma.notificationEmailHistory.findFirst({
        where: {
          userId,
          contactId: target.contactId,
          type,
          inactivitySessionId: activity.inactivitySessionId,
        },
      });

      if (alreadySent) {
        decisions.push({
          channel: NotificationChannel.EMAIL,
          shouldSend: false,
          reason: 'email-already-sent-for-inactivity-session',
        });
      } else {
        decisions.push({
          channel: NotificationChannel.EMAIL,
          shouldSend: true,
          reason: emailReason,
        });
      }
    } else {
      decisions.push({
        channel: NotificationChannel.EMAIL,
        shouldSend: emailEligible,
        reason: emailReason,
      });
    }

    decisions.push({
      channel: NotificationChannel.SOUND,
      shouldSend:
        hasForegroundSession && this.matchesSoundScope(prefs.soundScope, userId, target),
      reason: hasForegroundSession ? 'frontend-active-module-gates-final-playback' : 'no-active-session',
    });

    decisions.push({
      channel: NotificationChannel.CALL_SOUND,
      shouldSend:
        hasForegroundSession &&
        this.matchesCallSoundScope(prefs.callSoundScope, userId, target),
      reason: hasForegroundSession ? 'frontend-active-module-gates-final-playback' : 'no-active-session',
    });

    this.logDebug('evaluate', {
      userId,
      workspaceId,
      type,
      target: target ?? null,
      preferences: prefs,
      activity,
      hasLiveSession,
      hasForegroundSession,
      decisions,
    });

    return decisions;
  }

  private matchesEmailRules(
    type: NotificationType,
    activityStatus: UserPresenceStatus,
  ) {
    if (
      type === NotificationType.NEW_INCOMING_MESSAGE ||
      type === NotificationType.CONTACT_ASSIGNED
    ) {
      return activityStatus === UserPresenceStatus.OFFLINE;
    }

    return true;
  }

  private matchesPushRules(activityStatus: UserPresenceStatus) {
    return (
      activityStatus !== UserPresenceStatus.DND &&
      activityStatus !== UserPresenceStatus.BUSY
    );
  }

  private matchesContactScope(
    scope: NotificationContactScope,
    type: NotificationType,
    userId: string,
    target?: NotificationActorTarget,
  ) {
    if (
      type === NotificationType.COMMENT_MENTION ||
      scope === NotificationContactScope.MENTIONS_ONLY
    ) {
      return target?.mentionedUserIds?.includes(userId) ?? false;
    }

    if (
      type === NotificationType.CUSTOM_NOTIFICATION ||
      type === NotificationType.CONTACTS_IMPORT_COMPLETED ||
      type === NotificationType.DATA_EXPORT_READY
    ) {
      return scope !== NotificationContactScope.NONE;
    }

    switch (scope) {
      case NotificationContactScope.ALL_CONTACTS:
        return true;
      case NotificationContactScope.ASSIGNED_AND_UNASSIGNED:
        return !target?.assigneeId || target.assigneeId === userId;
      case NotificationContactScope.ASSIGNED_ONLY:
        return target?.assigneeId === userId;
      case NotificationContactScope.NONE:
      default:
        return false;
    }
  }

  private matchesSoundScope(
    scope: SoundNotificationScope,
    userId: string,
    target?: NotificationActorTarget,
  ) {
    if (scope === 'NONE') {
      return false;
    }

    if (scope === 'ASSIGNED_ONLY') {
      return target?.assigneeId === userId;
    }

    return !target?.assigneeId || target.assigneeId === userId;
  }

  private matchesCallSoundScope(
    scope: CallSoundNotificationScope,
    userId: string,
    target?: NotificationActorTarget,
  ) {
    switch (scope) {
      case 'ALL':
        return true;
      case 'ASSIGNED_ONLY':
        return target?.assigneeId === userId;
      case 'ASSIGNED_AND_UNASSIGNED':
        return !target?.assigneeId || target.assigneeId === userId;
      case 'MUTE_ALL':
      default:
        return false;
    }
  }

  private logDebug(event: string, details?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    console.info(`[NotificationDebug][RuleEngine] ${event}`, details ?? '');
  }
}
