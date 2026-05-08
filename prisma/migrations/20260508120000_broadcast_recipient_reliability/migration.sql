-- Broadcast reliability foundation:
-- - scheduled campaigns snapshot recipients at creation time
-- - each recipient gets one idempotency key and lifecycle row
-- - email broadcasts get one-click unsubscribe tokens

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "BroadcastRun"
  ADD COLUMN IF NOT EXISTS "audienceSnapshotStrategy" TEXT NOT NULL DEFAULT 'snapshot',
  ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "templateSnapshot" JSONB;

ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "broadcastRecipientId" UUID;

CREATE TABLE IF NOT EXISTS "BroadcastRecipient" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "broadcastRunId" UUID NOT NULL,
  "contactId" UUID NOT NULL,
  "contactChannelId" UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "conversationId" UUID,
  "identifier" TEXT NOT NULL,
  "recipientName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "idempotencyKey" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxRetries" INTEGER NOT NULL DEFAULT 3,
  "lastError" TEXT,
  "renderedText" TEXT,
  "renderedSubject" TEXT,
  "templateSnapshot" JSONB,
  "metadata" JSONB,
  "queuedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "unsubscribedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EmailUnsubscribeToken" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "contactId" UUID NOT NULL,
  "contactChannelId" UUID,
  "broadcastRunId" UUID,
  "broadcastRecipientId" UUID,
  "email" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "source" TEXT NOT NULL DEFAULT 'broadcast',
  "expiresAt" TIMESTAMP(3),
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailUnsubscribeToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BroadcastRecipient_workspaceId_idempotencyKey_key"
  ON "BroadcastRecipient"("workspaceId", "idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS "BroadcastRecipient_broadcastRunId_contactChannelId_key"
  ON "BroadcastRecipient"("broadcastRunId", "contactChannelId");

CREATE INDEX IF NOT EXISTS "BroadcastRecipient_workspaceId_broadcastRunId_status_idx"
  ON "BroadcastRecipient"("workspaceId", "broadcastRunId", "status");

CREATE INDEX IF NOT EXISTS "BroadcastRecipient_workspaceId_status_createdAt_idx"
  ON "BroadcastRecipient"("workspaceId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "BroadcastRecipient_channelId_providerMessageId_idx"
  ON "BroadcastRecipient"("channelId", "providerMessageId");

CREATE INDEX IF NOT EXISTS "BroadcastRecipient_contactChannelId_idx"
  ON "BroadcastRecipient"("contactChannelId");

CREATE UNIQUE INDEX IF NOT EXISTS "EmailUnsubscribeToken_token_key"
  ON "EmailUnsubscribeToken"("token");

CREATE INDEX IF NOT EXISTS "EmailUnsubscribeToken_workspaceId_contactId_status_idx"
  ON "EmailUnsubscribeToken"("workspaceId", "contactId", "status");

CREATE INDEX IF NOT EXISTS "EmailUnsubscribeToken_workspaceId_email_status_idx"
  ON "EmailUnsubscribeToken"("workspaceId", "email", "status");

CREATE INDEX IF NOT EXISTS "EmailUnsubscribeToken_broadcastRecipientId_idx"
  ON "EmailUnsubscribeToken"("broadcastRecipientId");

CREATE UNIQUE INDEX IF NOT EXISTS "Message_broadcastRecipientId_key"
  ON "Message"("broadcastRecipientId");

CREATE INDEX IF NOT EXISTS "Message_broadcastRecipientId_idx"
  ON "Message"("broadcastRecipientId");

CREATE INDEX IF NOT EXISTS "BroadcastRun_workspaceId_dedupeKey_createdAt_idx"
  ON "BroadcastRun"("workspaceId", "dedupeKey", "createdAt");

DO $$ BEGIN
 ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastRunId_fkey" FOREIGN KEY ("broadcastRunId") REFERENCES "BroadcastRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_contactChannelId_fkey" FOREIGN KEY ("contactChannelId") REFERENCES "ContactChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "Message" ADD CONSTRAINT "Message_broadcastRecipientId_fkey" FOREIGN KEY ("broadcastRecipientId") REFERENCES "BroadcastRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_contactChannelId_fkey" FOREIGN KEY ("contactChannelId") REFERENCES "ContactChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_broadcastRunId_fkey" FOREIGN KEY ("broadcastRunId") REFERENCES "BroadcastRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_broadcastRecipientId_fkey" FOREIGN KEY ("broadcastRecipientId") REFERENCES "BroadcastRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
