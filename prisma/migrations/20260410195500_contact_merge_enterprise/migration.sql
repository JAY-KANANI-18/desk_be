ALTER TABLE "Contact"
ADD COLUMN IF NOT EXISTS "mergedIntoContactId" UUID,
ADD COLUMN IF NOT EXISTS "mergedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "mergedByUserId" UUID;

CREATE INDEX IF NOT EXISTS "Contact_workspaceId_mergedIntoContactId_idx"
ON "Contact"("workspaceId", "mergedIntoContactId");

ALTER TABLE "Contact"
ADD CONSTRAINT "Contact_mergedIntoContactId_fkey"
FOREIGN KEY ("mergedIntoContactId") REFERENCES "Contact"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ContactMergeRun" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "primaryContactId" UUID NOT NULL,
  "secondaryContactId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "source" TEXT,
  "confidenceScore" INTEGER,
  "reasonCodes" JSONB,
  "resolution" JSONB,
  "summary" JSONB,
  "executedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMergeRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContactMergeRun_workspaceId_createdAt_idx"
ON "ContactMergeRun"("workspaceId", "createdAt");

CREATE INDEX IF NOT EXISTS "ContactMergeRun_primaryContactId_idx"
ON "ContactMergeRun"("primaryContactId");

CREATE INDEX IF NOT EXISTS "ContactMergeRun_secondaryContactId_idx"
ON "ContactMergeRun"("secondaryContactId");

ALTER TABLE "ContactMergeRun"
ADD CONSTRAINT "ContactMergeRun_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactMergeRun"
ADD CONSTRAINT "ContactMergeRun_primaryContactId_fkey"
FOREIGN KEY ("primaryContactId") REFERENCES "Contact"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactMergeRun"
ADD CONSTRAINT "ContactMergeRun_secondaryContactId_fkey"
FOREIGN KEY ("secondaryContactId") REFERENCES "Contact"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
