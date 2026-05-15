-- Integration platform foundation

ALTER TABLE "Channel"
ADD COLUMN "integrationId" UUID,
ADD COLUMN "integrationResourceId" UUID;

CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "externalAccountId" TEXT,
    "externalAccountName" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'oauth',
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "credentialsEncrypted" TEXT,
    "settings" JSONB,
    "metadata" JSONB,
    "health" JSONB,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationResource" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "settings" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationResource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactIntegration" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "resourceId" UUID,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "profile" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIntegration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "resourceId" UUID,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalEventId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "occurredAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "payload" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationJob" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "resourceId" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "input" JSONB,
    "output" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Integration_workspaceId_provider_externalAccountId_key"
ON "Integration"("workspaceId", "provider", "externalAccountId");

CREATE INDEX "Integration_workspaceId_provider_status_idx"
ON "Integration"("workspaceId", "provider", "status");

CREATE INDEX "Integration_workspaceId_category_status_idx"
ON "Integration"("workspaceId", "category", "status");

CREATE INDEX "Integration_externalAccountId_idx"
ON "Integration"("externalAccountId");

CREATE UNIQUE INDEX "IntegrationResource_integrationId_type_externalId_key"
ON "IntegrationResource"("integrationId", "type", "externalId");

CREATE INDEX "IntegrationResource_workspaceId_type_status_idx"
ON "IntegrationResource"("workspaceId", "type", "status");

CREATE INDEX "IntegrationResource_workspaceId_integrationId_idx"
ON "IntegrationResource"("workspaceId", "integrationId");

CREATE UNIQUE INDEX "ContactIntegration_integrationId_externalId_key"
ON "ContactIntegration"("integrationId", "externalId");

CREATE INDEX "ContactIntegration_workspaceId_contactId_idx"
ON "ContactIntegration"("workspaceId", "contactId");

CREATE INDEX "ContactIntegration_workspaceId_provider_externalId_idx"
ON "ContactIntegration"("workspaceId", "provider", "externalId");

CREATE INDEX "ContactIntegration_workspaceId_email_idx"
ON "ContactIntegration"("workspaceId", "email");

CREATE INDEX "ContactIntegration_workspaceId_phone_idx"
ON "ContactIntegration"("workspaceId", "phone");

CREATE UNIQUE INDEX "IntegrationEvent_integrationId_idempotencyKey_key"
ON "IntegrationEvent"("integrationId", "idempotencyKey");

CREATE INDEX "IntegrationEvent_workspaceId_eventType_createdAt_idx"
ON "IntegrationEvent"("workspaceId", "eventType", "createdAt");

CREATE INDEX "IntegrationEvent_workspaceId_status_createdAt_idx"
ON "IntegrationEvent"("workspaceId", "status", "createdAt");

CREATE INDEX "IntegrationEvent_provider_externalEventId_idx"
ON "IntegrationEvent"("provider", "externalEventId");

CREATE INDEX "IntegrationJob_status_scheduledAt_idx"
ON "IntegrationJob"("status", "scheduledAt");

CREATE INDEX "IntegrationJob_workspaceId_integrationId_status_idx"
ON "IntegrationJob"("workspaceId", "integrationId", "status");

CREATE INDEX "IntegrationJob_workspaceId_type_createdAt_idx"
ON "IntegrationJob"("workspaceId", "type", "createdAt");

CREATE INDEX "Channel_workspaceId_integrationId_idx"
ON "Channel"("workspaceId", "integrationId");

CREATE INDEX "Channel_integrationResourceId_idx"
ON "Channel"("integrationResourceId");

ALTER TABLE "Integration"
ADD CONSTRAINT "Integration_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationResource"
ADD CONSTRAINT "IntegrationResource_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationResource"
ADD CONSTRAINT "IntegrationResource_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactIntegration"
ADD CONSTRAINT "ContactIntegration_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactIntegration"
ADD CONSTRAINT "ContactIntegration_contactId_fkey"
FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactIntegration"
ADD CONSTRAINT "ContactIntegration_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactIntegration"
ADD CONSTRAINT "ContactIntegration_resourceId_fkey"
FOREIGN KEY ("resourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationEvent"
ADD CONSTRAINT "IntegrationEvent_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationEvent"
ADD CONSTRAINT "IntegrationEvent_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationEvent"
ADD CONSTRAINT "IntegrationEvent_resourceId_fkey"
FOREIGN KEY ("resourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationJob"
ADD CONSTRAINT "IntegrationJob_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationJob"
ADD CONSTRAINT "IntegrationJob_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationJob"
ADD CONSTRAINT "IntegrationJob_resourceId_fkey"
FOREIGN KEY ("resourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Channel"
ADD CONSTRAINT "Channel_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Channel"
ADD CONSTRAINT "Channel_integrationResourceId_fkey"
FOREIGN KEY ("integrationResourceId") REFERENCES "IntegrationResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
