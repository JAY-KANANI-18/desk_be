CREATE TABLE "WorkspaceAiSettings" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "provider" TEXT NOT NULL DEFAULT 'cohere',
  "model" TEXT NOT NULL DEFAULT 'command-a-03-2025',
  "autoSuggest" BOOLEAN NOT NULL DEFAULT false,
  "smartReply" BOOLEAN NOT NULL DEFAULT true,
  "summarize" BOOLEAN NOT NULL DEFAULT true,
  "sentiment" BOOLEAN NOT NULL DEFAULT false,
  "translate" BOOLEAN NOT NULL DEFAULT true,
  "defaultLanguage" TEXT NOT NULL DEFAULT 'auto',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkspaceAiSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceAiPrompt" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "key" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "kind" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "options" JSONB,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WorkspaceAiPrompt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceAiSettings_workspaceId_key" ON "WorkspaceAiSettings"("workspaceId");
CREATE INDEX "WorkspaceAiSettings_workspaceId_idx" ON "WorkspaceAiSettings"("workspaceId");
CREATE INDEX "WorkspaceAiPrompt_workspaceId_kind_sortOrder_idx" ON "WorkspaceAiPrompt"("workspaceId", "kind", "sortOrder");
CREATE UNIQUE INDEX "WorkspaceAiPrompt_workspaceId_key_key" ON "WorkspaceAiPrompt"("workspaceId", "key");

ALTER TABLE "WorkspaceAiSettings"
ADD CONSTRAINT "WorkspaceAiSettings_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceAiPrompt"
ADD CONSTRAINT "WorkspaceAiPrompt_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
