ALTER TABLE "NotificationDelivery"
ADD COLUMN "details" JSONB,
ADD COLUMN "completedAt" TIMESTAMP(3);

ALTER TABLE "NotificationDevice"
ADD COLUMN "deviceKey" TEXT,
ADD COLUMN "authSecret" TEXT,
ADD COLUMN "p256dhKey" TEXT,
ADD COLUMN "expirationTime" TIMESTAMP(3),
ADD COLUMN "pushPermission" TEXT,
ADD COLUMN "lastSuccessfulDeliveryAt" TIMESTAMP(3),
ADD COLUMN "lastFailureAt" TIMESTAMP(3),
ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "invalidatedAt" TIMESTAMP(3),
ADD COLUMN "disabledReason" TEXT,
ADD COLUMN "lastSubscriptionChangeAt" TIMESTAMP(3);

CREATE TABLE "NotificationDeliveryAttempt" (
  "id" UUID NOT NULL,
  "notificationDeliveryId" UUID NOT NULL,
  "notificationDeviceId" UUID,
  "targetIdentifier" TEXT NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "providerMessageId" TEXT,
  "providerStatusCode" INTEGER,
  "lastError" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "invalidatedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDevice_deviceKey_key"
ON "NotificationDevice"("deviceKey");

CREATE INDEX "NotificationDevice_workspaceId_disabledAt_invalidatedAt_idx"
ON "NotificationDevice"("workspaceId", "disabledAt", "invalidatedAt");

CREATE UNIQUE INDEX "NotificationDeliveryAttempt_notificationDeliveryId_targetIdentifier_key"
ON "NotificationDeliveryAttempt"("notificationDeliveryId", "targetIdentifier");

CREATE INDEX "NotificationDeliveryAttempt_notificationDeviceId_status_idx"
ON "NotificationDeliveryAttempt"("notificationDeviceId", "status");

CREATE INDEX "NotificationDeliveryAttempt_status_lastAttemptAt_idx"
ON "NotificationDeliveryAttempt"("status", "lastAttemptAt");

ALTER TABLE "NotificationDeliveryAttempt"
ADD CONSTRAINT "NotificationDeliveryAttempt_notificationDeliveryId_fkey"
FOREIGN KEY ("notificationDeliveryId") REFERENCES "NotificationDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDeliveryAttempt"
ADD CONSTRAINT "NotificationDeliveryAttempt_notificationDeviceId_fkey"
FOREIGN KEY ("notificationDeviceId") REFERENCES "NotificationDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
