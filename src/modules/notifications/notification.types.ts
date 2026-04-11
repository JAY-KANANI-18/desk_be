import {
  CallSoundNotificationScope,
  NotificationChannel,
  NotificationContactScope,
  NotificationType,
  SoundNotificationScope,
} from '@prisma/client';

export { NotificationChannel, NotificationContactScope, NotificationType };

export const NOTIFICATION_CENTER_DEFAULTS: Record<NotificationType, boolean> = {
  NEW_INCOMING_MESSAGE: false,
  CONTACT_ASSIGNED: false,
  COMMENT_MENTION: true,
  CUSTOM_NOTIFICATION: true,
  CONTACTS_IMPORT_COMPLETED: true,
  DATA_EXPORT_READY: true,
  NEW_INCOMING_CALL: false,
};

export const DESKTOP_DEFAULTS: Record<NotificationType, boolean> = {
  NEW_INCOMING_MESSAGE: true,
  CONTACT_ASSIGNED: true,
  COMMENT_MENTION: true,
  CUSTOM_NOTIFICATION: true,
  CONTACTS_IMPORT_COMPLETED: false,
  DATA_EXPORT_READY: false,
  NEW_INCOMING_CALL: true,
};

export const MOBILE_DEFAULTS = { ...DESKTOP_DEFAULTS };

export const EMAIL_DEFAULTS: Record<NotificationType, boolean> = {
  NEW_INCOMING_MESSAGE: true,
  CONTACT_ASSIGNED: true,
  COMMENT_MENTION: true,
  CUSTOM_NOTIFICATION: false,
  CONTACTS_IMPORT_COMPLETED: true,
  DATA_EXPORT_READY: true,
  NEW_INCOMING_CALL: false,
};

export const SOUND_EVENT_TYPES = new Set<NotificationType>([
  NotificationType.NEW_INCOMING_MESSAGE,
  NotificationType.CONTACT_ASSIGNED,
  NotificationType.COMMENT_MENTION,
  NotificationType.NEW_INCOMING_CALL,
]);

export interface NotificationActorTarget {
  assigneeId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  mentionedUserIds?: string[];
}

export interface NotificationEventInput {
  userId: string;
  workspaceId: string;
  organizationId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  dedupeKey?: string | null;
  target?: NotificationActorTarget;
}

export interface NotificationDeliveryDecision {
  channel: NotificationChannel;
  shouldSend: boolean;
  reason: string;
}

export interface NotificationPreferenceSnapshot {
  soundScope: SoundNotificationScope;
  callSoundScope: CallSoundNotificationScope;
  desktopScope: NotificationContactScope;
  mobileScope: NotificationContactScope;
  emailScope: NotificationContactScope;
}
