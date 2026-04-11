-- Add schedule metadata and stored payload needed for delayed broadcast execution.
ALTER TABLE "BroadcastRun" ADD COLUMN IF NOT EXISTS "templateVariables" JSONB;
ALTER TABLE "BroadcastRun" ADD COLUMN IF NOT EXISTS "messageText" TEXT;
ALTER TABLE "BroadcastRun" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);
ALTER TABLE "BroadcastRun" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "BroadcastRun" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "BroadcastRun_status_scheduledAt_idx" ON "BroadcastRun"("status", "scheduledAt");
