CREATE TYPE "NotificationType_new" AS ENUM (
  'NEW_INCOMING_MESSAGE',
  'CONTACT_ASSIGNED',
  'COMMENT_MENTION',
  'CUSTOM_NOTIFICATION',
  'CONTACTS_IMPORT_COMPLETED',
  'DATA_EXPORT_READY',
  'NEW_INCOMING_CALL'
);

CREATE TYPE "NotificationChannel" AS ENUM (
  'IN_APP',
  'DESKTOP',
  'MOBILE_PUSH',
  'EMAIL',
  'SOUND',
  'CALL_SOUND'
);

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'PENDING',
  'SENT',
  'SKIPPED',
  'FAILED',
  'SUPPRESSED'
);

CREATE TYPE "NotificationContactScope" AS ENUM (
  'ALL_CONTACTS',
  'ASSIGNED_AND_UNASSIGNED',
  'ASSIGNED_ONLY',
  'MENTIONS_ONLY',
  'NONE'
);

CREATE TYPE "SoundNotificationScope" AS ENUM (
  'ASSIGNED_AND_UNASSIGNED',
  'ASSIGNED_ONLY',
  'NONE'
);

CREATE TYPE "CallSoundNotificationScope" AS ENUM (
  'ASSIGNED_AND_UNASSIGNED',
  'ASSIGNED_ONLY',
  'ALL',
  'MUTE_ALL'
);

CREATE TYPE "UserPresenceStatus" AS ENUM (
  'ACTIVE',
  'OFFLINE',
  'AWAY',
  'BUSY',
  'DND'
);

ALTER TABLE "Workspace"
ADD COLUMN "notificationInactivityTimeoutSec" INTEGER NOT NULL DEFAULT 300;

ALTER TABLE "UserActivity"
ADD COLUMN "lastActivityAt" TIMESTAMP(3),
ADD COLUMN "lastWorkspaceId" UUID,
ADD COLUMN "inactivitySessionId" UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE "UserActivity"
ALTER COLUMN "activityStatus" DROP DEFAULT;

ALTER TABLE "UserActivity"
ALTER COLUMN "activityStatus" TYPE "UserPresenceStatus"
USING (
  CASE
    WHEN LOWER("activityStatus") = 'online' THEN 'ACTIVE'::"UserPresenceStatus"
    WHEN LOWER("activityStatus") = 'away' THEN 'AWAY'::"UserPresenceStatus"
    WHEN LOWER("activityStatus") = 'busy' THEN 'BUSY'::"UserPresenceStatus"
    WHEN LOWER("activityStatus") = 'dnd' THEN 'DND'::"UserPresenceStatus"
    ELSE 'OFFLINE'::"UserPresenceStatus"
  END
);

ALTER TABLE "UserActivity"
ALTER COLUMN "activityStatus" SET DEFAULT 'OFFLINE';

ALTER TABLE "Notification"
ADD COLUMN "workspaceId" UUID,
ADD COLUMN "organizationId" UUID,
ADD COLUMN "sourceEntityType" TEXT,
ADD COLUMN "sourceEntityId" TEXT,
ADD COLUMN "dedupeKey" TEXT,
ADD COLUMN "readAt" TIMESTAMP(3),
ADD COLUMN "archivedAt" TIMESTAMP(3);

UPDATE "Notification"
SET "readAt" = CASE WHEN "isRead" = true THEN "createdAt" ELSE NULL END;

ALTER TABLE "Notification"
ALTER COLUMN "type" TYPE "NotificationType_new"
USING (
  CASE "type"
    WHEN 'NEW_MESSAGE' THEN 'NEW_INCOMING_MESSAGE'::"NotificationType_new"
    WHEN 'MENTION' THEN 'COMMENT_MENTION'::"NotificationType_new"
    WHEN 'ASSIGNED' THEN 'CONTACT_ASSIGNED'::"NotificationType_new"
    WHEN 'IMPORT_STATUS' THEN 'CONTACTS_IMPORT_COMPLETED'::"NotificationType_new"
    WHEN 'EXPORT_STATUS' THEN 'DATA_EXPORT_READY'::"NotificationType_new"
    ELSE 'CUSTOM_NOTIFICATION'::"NotificationType_new"
  END
);

ALTER TABLE "Notification" DROP COLUMN "isRead";

DROP TYPE "NotificationType";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "NotificationPreference";

CREATE TABLE "NotificationPreference" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "soundScope" "SoundNotificationScope" NOT NULL DEFAULT 'ASSIGNED_AND_UNASSIGNED',
  "callSoundScope" "CallSoundNotificationScope" NOT NULL DEFAULT 'ASSIGNED_AND_UNASSIGNED',
  "desktopScope" "NotificationContactScope" NOT NULL DEFAULT 'ALL_CONTACTS',
  "mobileScope" "NotificationContactScope" NOT NULL DEFAULT 'ALL_CONTACTS',
  "emailScope" "NotificationContactScope" NOT NULL DEFAULT 'ALL_CONTACTS',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationDelivery" (
  "id" UUID NOT NULL,
  "notificationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationDevice" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "workspaceId" UUID,
  "platform" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "deviceName" TEXT,
  "metadata" JSONB,
  "lastSeenAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationEmailHistory" (
  "id" UUID NOT NULL,
  "notificationId" UUID,
  "userId" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "contactId" UUID,
  "type" "NotificationType" NOT NULL,
  "inactivitySessionId" UUID NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationEmailHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userId_workspaceId_key"
ON "NotificationPreference"("userId", "workspaceId");
CREATE INDEX "NotificationPreference_workspaceId_idx"
ON "NotificationPreference"("workspaceId");

CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key"
ON "NotificationDelivery"("notificationId", "channel");
CREATE INDEX "NotificationDelivery_userId_channel_status_idx"
ON "NotificationDelivery"("userId", "channel", "status");

CREATE UNIQUE INDEX "NotificationDevice_token_key"
ON "NotificationDevice"("token");
CREATE INDEX "NotificationDevice_userId_disabledAt_idx"
ON "NotificationDevice"("userId", "disabledAt");

CREATE UNIQUE INDEX "NotificationEmailHistory_userId_contactId_type_inactivitySessionId_key"
ON "NotificationEmailHistory"("userId", "contactId", "type", "inactivitySessionId");
CREATE INDEX "NotificationEmailHistory_contactId_userId_inactivitySessionId_idx"
ON "NotificationEmailHistory"("contactId", "userId", "inactivitySessionId");
CREATE INDEX "NotificationEmailHistory_workspaceId_sentAt_idx"
ON "NotificationEmailHistory"("workspaceId", "sentAt");

CREATE INDEX "Notification_userId_createdAt_idx"
ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_archivedAt_createdAt_idx"
ON "Notification"("userId", "readAt", "archivedAt", "createdAt");
CREATE INDEX "Notification_workspaceId_createdAt_idx"
ON "Notification"("workspaceId", "createdAt");
CREATE INDEX "Notification_dedupeKey_idx"
ON "Notification"("dedupeKey");

ALTER TABLE "NotificationPreference"
ADD CONSTRAINT "NotificationPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationPreference"
ADD CONSTRAINT "NotificationPreference_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDelivery"
ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDelivery"
ADD CONSTRAINT "NotificationDelivery_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDevice"
ADD CONSTRAINT "NotificationDevice_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDevice"
ADD CONSTRAINT "NotificationDevice_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NotificationEmailHistory"
ADD CONSTRAINT "NotificationEmailHistory_notificationId_fkey"
FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NotificationEmailHistory"
ADD CONSTRAINT "NotificationEmailHistory_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationEmailHistory"
ADD CONSTRAINT "NotificationEmailHistory_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
