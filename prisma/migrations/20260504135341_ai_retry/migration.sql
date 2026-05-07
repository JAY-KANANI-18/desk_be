-- Axodesk Enterprise AI Agent Platform foundation.
-- Tables are intentionally snake_case because they model an AI platform domain
-- that is shared by API services, workers, analytics, and Supabase SQL tooling.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE OR REPLACE FUNCTION ai_workspace_allowed(row_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on'
      OR current_setting('app.workspace_id', true) = row_workspace_id::text
$$;

CREATE TABLE "ai_agents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "agent_type" TEXT NOT NULL DEFAULT 'custom',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "active_version_id" UUID,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3),

  CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_agents_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_agents_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_agents_status_check"
    CHECK ("status" IN ('draft', 'active', 'paused', 'archived')),
  CONSTRAINT "ai_agents_type_check"
    CHECK ("agent_type" IN ('sales', 'support', 'receptionist', 'custom'))
);

CREATE TABLE "ai_agent_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "name" TEXT NOT NULL,
  "tone" TEXT NOT NULL DEFAULT 'professional',
  "default_language" TEXT NOT NULL DEFAULT 'auto',
  "channel_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "business_hours" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "llm_config" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "runtime_config" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "guardrails" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "tools_allowed" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "knowledge_source_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "system_prompt" TEXT NOT NULL DEFAULT '',
  "approval_mode" TEXT NOT NULL DEFAULT 'off',
  "sandbox_mode" BOOLEAN NOT NULL DEFAULT false,
  "created_by_user_id" UUID,
  "published_by_user_id" UUID,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_agent_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_agent_versions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_agent_versions_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_agent_versions_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_agent_versions_published_by_user_id_fkey"
    FOREIGN KEY ("published_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_agent_versions_status_check"
    CHECK ("status" IN ('draft', 'published', 'archived')),
  CONSTRAINT "ai_agent_versions_approval_mode_check"
    CHECK ("approval_mode" IN ('off', 'first_reply', 'all_replies', 'tools_only')),
  CONSTRAINT "ai_agent_versions_agent_version_key" UNIQUE ("agent_id", "version")
);

ALTER TABLE "ai_agents"
  ADD CONSTRAINT "ai_agents_active_version_id_fkey"
  FOREIGN KEY ("active_version_id") REFERENCES "ai_agent_versions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ai_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "agent_version_id" UUID NOT NULL,
  "conversation_id" UUID,
  "contact_id" UUID,
  "trigger_message_id" UUID,
  "idempotency_key" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'auto',
  "status" TEXT NOT NULL DEFAULT 'queued',
  "channel_type" TEXT,
  "intent" TEXT,
  "confidence" NUMERIC(5,4),
  "handoff_required" BOOLEAN NOT NULL DEFAULT false,
  "request_snapshot" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "decision_snapshot" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "response_snapshot" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "latency_ms" INTEGER,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_runs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_runs_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_runs_agent_version_id_fkey"
    FOREIGN KEY ("agent_version_id") REFERENCES "ai_agent_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_runs_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_runs_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_runs_trigger_message_id_fkey"
    FOREIGN KEY ("trigger_message_id") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'escalated')),
  CONSTRAINT "ai_runs_mode_check"
    CHECK ("mode" IN ('auto', 'sandbox', 'approval', 'manual')),
  CONSTRAINT "ai_runs_idempotency_key_key" UNIQUE ("workspace_id", "idempotency_key")
);

CREATE TABLE "ai_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "conversation_id" UUID,
  "message_id" UUID,
  "role" TEXT NOT NULL,
  "content" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
  "completion_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_messages_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_messages_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_messages_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_messages_role_check"
    CHECK ("role" IN ('system', 'customer', 'assistant', 'tool', 'policy'))
);

CREATE TABLE "ai_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "tool_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "requires_approval" BOOLEAN NOT NULL DEFAULT false,
  "approved_by_user_id" UUID,
  "approved_at" TIMESTAMP(3),
  "input" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "output" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_actions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_actions_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_actions_approved_by_user_id_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_actions_status_check"
    CHECK ("status" IN ('planned', 'waiting_approval', 'running', 'succeeded', 'failed', 'skipped'))
);

CREATE TABLE "ai_tool_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID,
  "action_id" UUID,
  "tool_name" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "input" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "output" JSONB,
  "error_code" TEXT,
  "error_message" TEXT,
  "latency_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_tool_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_tool_logs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_tool_logs_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_tool_logs_action_id_fkey"
    FOREIGN KEY ("action_id") REFERENCES "ai_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_tool_logs_status_check"
    CHECK ("status" IN ('succeeded', 'failed', 'denied', 'skipped'))
);

CREATE TABLE "ai_memories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "contact_id" UUID,
  "conversation_id" UUID,
  "scope" TEXT NOT NULL,
  "memory_key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'ai',
  "confidence" NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_memories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_memories_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_memories_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_memories_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_memories_scope_check"
    CHECK ("scope" IN ('conversation', 'contact', 'workspace'))
);

CREATE UNIQUE INDEX "ai_memories_contact_key_unique"
  ON "ai_memories"("workspace_id", "contact_id", "memory_key")
  WHERE "scope" = 'contact' AND "contact_id" IS NOT NULL;

CREATE UNIQUE INDEX "ai_memories_conversation_key_unique"
  ON "ai_memories"("workspace_id", "conversation_id", "memory_key")
  WHERE "scope" = 'conversation' AND "conversation_id" IS NOT NULL;

CREATE TABLE "ai_knowledge_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "uri" TEXT,
  "file_asset_id" UUID,
  "crawler_config" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "import_config" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "checksum" TEXT,
  "embedding_provider" TEXT NOT NULL DEFAULT 'openai',
  "embedding_model" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  "embedding_dim" INTEGER NOT NULL DEFAULT 1536,
  "last_indexed_at" TIMESTAMP(3),
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "ai_knowledge_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_knowledge_sources_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_knowledge_sources_file_asset_id_fkey"
    FOREIGN KEY ("file_asset_id") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_knowledge_sources_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_knowledge_sources_type_check"
    CHECK ("source_type" IN ('file', 'website', 'faq', 'product_catalog', 'manual')),
  CONSTRAINT "ai_knowledge_sources_status_check"
    CHECK ("status" IN ('pending', 'indexing', 'ready', 'failed', 'disabled'))
);

CREATE TABLE "ai_knowledge_chunks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "chunk_index" INTEGER NOT NULL,
  "title" TEXT,
  "content" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "token_count" INTEGER NOT NULL DEFAULT 0,
  "embedding_provider" TEXT NOT NULL DEFAULT 'openai',
  "embedding_model" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  "embedding_dim" INTEGER NOT NULL DEFAULT 1536,
  "embedding" vector(1536),
  "search_text" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("content", ''))) STORED,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_knowledge_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_knowledge_chunks_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_knowledge_chunks_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "ai_knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_knowledge_chunks_source_chunk_key" UNIQUE ("source_id", "chunk_index"),
  CONSTRAINT "ai_knowledge_chunks_source_hash_key" UNIQUE ("source_id", "content_hash")
);

CREATE TABLE "ai_feedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID,
  "conversation_id" UUID,
  "message_id" UUID,
  "rating" INTEGER,
  "label" TEXT,
  "comment" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_feedback_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_feedback_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_feedback_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_feedback_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_feedback_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_feedback_rating_check"
    CHECK ("rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5))
);

CREATE TABLE "ai_guardrails" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "agent_id" UUID,
  "name" TEXT NOT NULL,
  "rule_type" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'block',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_guardrails_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_guardrails_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_guardrails_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_guardrails_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_guardrails_rule_type_check"
    CHECK ("rule_type" IN ('pricing', 'refund', 'legal', 'medical', 'profanity', 'confidence', 'max_auto_replies', 'prompt_injection', 'data_leak')),
  CONSTRAINT "ai_guardrails_severity_check"
    CHECK ("severity" IN ('allow', 'warn', 'block', 'handoff'))
);

CREATE TABLE "ai_escalations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID,
  "conversation_id" UUID NOT NULL,
  "contact_id" UUID,
  "reason" TEXT NOT NULL,
  "sentiment" TEXT,
  "summary" TEXT,
  "assigned_user_id" UUID,
  "assigned_team_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),

  CONSTRAINT "ai_escalations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_escalations_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_escalations_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_escalations_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_escalations_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_escalations_assigned_user_id_fkey"
    FOREIGN KEY ("assigned_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_escalations_assigned_team_id_fkey"
    FOREIGN KEY ("assigned_team_id") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_escalations_status_check"
    CHECK ("status" IN ('open', 'assigned', 'resolved', 'cancelled'))
);

CREATE TABLE "ai_usage_billing" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "run_id" UUID,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
  "completion_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_tokens" INTEGER NOT NULL DEFAULT 0,
  "cost_micros" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_usage_billing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_usage_billing_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_billing_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ai_agents_workspace_status_idx" ON "ai_agents"("workspace_id", "status");
CREATE INDEX "ai_agent_versions_workspace_status_idx" ON "ai_agent_versions"("workspace_id", "status");
CREATE INDEX "ai_runs_workspace_created_idx" ON "ai_runs"("workspace_id", "created_at" DESC);
CREATE INDEX "ai_runs_conversation_created_idx" ON "ai_runs"("conversation_id", "created_at" DESC);
CREATE INDEX "ai_messages_run_created_idx" ON "ai_messages"("run_id", "created_at");
CREATE INDEX "ai_actions_run_status_idx" ON "ai_actions"("run_id", "status");
CREATE INDEX "ai_tool_logs_workspace_created_idx" ON "ai_tool_logs"("workspace_id", "created_at" DESC);
CREATE INDEX "ai_memories_workspace_contact_idx" ON "ai_memories"("workspace_id", "contact_id");
CREATE INDEX "ai_knowledge_sources_workspace_status_idx" ON "ai_knowledge_sources"("workspace_id", "status");
CREATE INDEX "ai_knowledge_chunks_workspace_source_idx" ON "ai_knowledge_chunks"("workspace_id", "source_id");
CREATE INDEX "ai_knowledge_chunks_search_idx" ON "ai_knowledge_chunks" USING GIN ("search_text");
CREATE INDEX "ai_knowledge_chunks_embedding_hnsw_idx"
  ON "ai_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
CREATE INDEX "ai_feedback_workspace_created_idx" ON "ai_feedback"("workspace_id", "created_at" DESC);
CREATE INDEX "ai_guardrails_workspace_agent_idx" ON "ai_guardrails"("workspace_id", "agent_id", "enabled");
CREATE INDEX "ai_escalations_workspace_status_idx" ON "ai_escalations"("workspace_id", "status", "created_at" DESC);
CREATE INDEX "ai_usage_billing_workspace_period_idx" ON "ai_usage_billing"("workspace_id", "period_start", "provider", "model");

ALTER TABLE "ai_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_agent_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_tool_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_memories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_knowledge_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_knowledge_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_guardrails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_escalations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_billing" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_agents_workspace_policy" ON "ai_agents" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_agent_versions_workspace_policy" ON "ai_agent_versions" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_runs_workspace_policy" ON "ai_runs" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_messages_workspace_policy" ON "ai_messages" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_actions_workspace_policy" ON "ai_actions" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_tool_logs_workspace_policy" ON "ai_tool_logs" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_memories_workspace_policy" ON "ai_memories" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_knowledge_sources_workspace_policy" ON "ai_knowledge_sources" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_knowledge_chunks_workspace_policy" ON "ai_knowledge_chunks" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_feedback_workspace_policy" ON "ai_feedback" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_guardrails_workspace_policy" ON "ai_guardrails" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_escalations_workspace_policy" ON "ai_escalations" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
CREATE POLICY "ai_usage_billing_workspace_policy" ON "ai_usage_billing" FOR ALL USING (ai_workspace_allowed("workspace_id")) WITH CHECK (ai_workspace_allowed("workspace_id"));
