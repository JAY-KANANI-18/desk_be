CREATE TABLE "Snippet" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "shortcut" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "topic" TEXT,
  "attachments" JSONB,
  "createdById" UUID,
  "updatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Snippet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Snippet_workspaceId_shortcut_key" ON "Snippet"("workspaceId", "shortcut");
CREATE INDEX "Snippet_workspaceId_topic_idx" ON "Snippet"("workspaceId", "topic");
CREATE INDEX "Snippet_workspaceId_updatedAt_idx" ON "Snippet"("workspaceId", "updatedAt");

ALTER TABLE "Snippet"
ADD CONSTRAINT "Snippet_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
