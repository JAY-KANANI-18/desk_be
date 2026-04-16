import { NotificationType } from '@prisma/client';

type RouteContext = {
  type: NotificationType;
  workspaceId?: string | null;
  sourceEntityType?: string | null;
  metadata?: Record<string, unknown> | null;
};

type PushPayloadContext = RouteContext & {
  id: string;
  title: string;
  body?: string | null;
};

const DEFAULT_NOTIFICATION_ROUTE = '/user/settings/notifications';
const DEFAULT_BADGE_ICON = '/pwa/icon-192.png';

export const resolveNotificationDeepLink = (context: RouteContext) => {
  const metadata = context.metadata ?? {};
  if (typeof metadata.deepLink === 'string' && metadata.deepLink.trim()) {
    return metadata.deepLink;
  }

  const query = new URLSearchParams();
  if (context.workspaceId) {
    query.set('workspaceId', context.workspaceId);
  }

  const conversationId = readString(metadata.conversationId);
  if (conversationId) {
    const targetMessageId =
      readString(metadata.targetMessageId) || readString(metadata.messageId);
    if (targetMessageId) {
      query.set('targetMessageId', targetMessageId);
    }
    return `/inbox/${conversationId}${queryString(query)}`;
  }

  const jobId = readString(metadata.jobId);
  if (
    jobId &&
    (context.sourceEntityType === 'import_export_job' ||
      context.type === NotificationType.CONTACTS_IMPORT_COMPLETED ||
      context.type === NotificationType.DATA_EXPORT_READY)
  ) {
    query.set('jobId', jobId);
    return `/contacts/import-jobs${queryString(query)}`;
  }

  return `${DEFAULT_NOTIFICATION_ROUTE}${queryString(query)}`;
};

export const decorateNotificationMetadata = (
  metadata: Record<string, unknown> | null | undefined,
  context: Omit<RouteContext, 'metadata'>,
) => {
  const normalizedMetadata = {
    ...(metadata ?? {}),
  };

  if (!normalizedMetadata.deepLink) {
    normalizedMetadata.deepLink = resolveNotificationDeepLink({
      ...context,
      metadata: normalizedMetadata,
    });
  }

  return normalizedMetadata;
};

export const buildNotificationPushPayload = (notification: PushPayloadContext) => {
  const metadata = notification.metadata ?? {};
  const deepLink = resolveNotificationDeepLink(notification);

  return {
    title: notification.title,
    body: notification.body ?? '',
    icon: readString(metadata.iconUrl) || DEFAULT_BADGE_ICON,
    badge: readString(metadata.badgeUrl) || DEFAULT_BADGE_ICON,
    tag: `notification:${notification.id}`,
    requireInteraction: notification.type === NotificationType.NEW_INCOMING_CALL,
    renotify: notification.type === NotificationType.NEW_INCOMING_CALL,
    data: {
      notificationId: notification.id,
      type: notification.type,
      workspaceId: notification.workspaceId ?? null,
      deepLink,
      conversationId: readString(metadata.conversationId),
      jobId: readString(metadata.jobId),
    },
  };
};

const readString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : null;

const queryString = (params: URLSearchParams) => {
  const value = params.toString();
  return value ? `?${value}` : '';
};
