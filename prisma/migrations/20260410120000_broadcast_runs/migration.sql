-- AlterTable
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "marketingOptOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "BroadcastRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "audienceFilters" JSONB NOT NULL,
    "contentMode" TEXT NOT NULL,
    "templateName" TEXT,
    "templateLanguage" TEXT,
    "textPreview" TEXT,
    "totalAudience" INTEGER NOT NULL,
    "queuedCount" INTEGER NOT NULL,
    "failedEnqueue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "BroadcastRun_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "broadcastRunId" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Message_broadcastRunId_idx" ON "Message"("broadcastRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BroadcastRun_workspaceId_createdAt_idx" ON "BroadcastRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BroadcastRun_channelId_idx" ON "BroadcastRun"("channelId");

-- AddForeignKey
DO $$ BEGIN
 ALTER TABLE "BroadcastRun" ADD CONSTRAINT "BroadcastRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRun" ADD CONSTRAINT "BroadcastRun_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "BroadcastRun" ADD CONSTRAINT "BroadcastRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "Message" ADD CONSTRAINT "Message_broadcastRunId_fkey" FOREIGN KEY ("broadcastRunId") REFERENCES "BroadcastRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
