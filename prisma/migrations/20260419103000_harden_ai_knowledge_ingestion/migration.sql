ALTER TABLE "ai_knowledge_sources"
  ALTER COLUMN "status" SET DEFAULT 'queued';

ALTER TABLE "ai_knowledge_sources"
  DROP CONSTRAINT IF EXISTS "ai_knowledge_sources_status_check";

ALTER TABLE "ai_knowledge_sources"
  ADD CONSTRAINT "ai_knowledge_sources_status_check"
  CHECK ("status" IN (
    'queued',
    'pending',
    'fetching',
    'extracting',
    'embedding',
    'indexing',
    'ready',
    'completed',
    'partial_success',
    'failed',
    'disabled'
  ));

ALTER TABLE "ai_knowledge_chunks"
  ADD COLUMN IF NOT EXISTS "url" TEXT,
  ADD COLUMN IF NOT EXISTS "canonical_url" TEXT,
  ADD COLUMN IF NOT EXISTS "clean_text" TEXT,
  ADD COLUMN IF NOT EXISTS "embedding_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "last_crawled_at" TIMESTAMP(3);

UPDATE "ai_knowledge_chunks"
SET "clean_text" = COALESCE("clean_text", "content"),
    "embedding_status" = CASE WHEN "embedding" IS NULL THEN 'lexical_only' ELSE 'embedded' END
WHERE "clean_text" IS NULL
   OR "embedding_status" = 'pending';

ALTER TABLE "ai_knowledge_chunks"
  DROP CONSTRAINT IF EXISTS "ai_knowledge_chunks_embedding_status_check";

ALTER TABLE "ai_knowledge_chunks"
  ADD CONSTRAINT "ai_knowledge_chunks_embedding_status_check"
  CHECK ("embedding_status" IN ('pending', 'embedded', 'lexical_only', 'failed'));

CREATE INDEX IF NOT EXISTS "ai_knowledge_chunks_canonical_url_idx"
  ON "ai_knowledge_chunks"("workspace_id", "source_id", "canonical_url");

CREATE INDEX IF NOT EXISTS "ai_knowledge_chunks_embedding_status_idx"
  ON "ai_knowledge_chunks"("workspace_id", "source_id", "embedding_status");
