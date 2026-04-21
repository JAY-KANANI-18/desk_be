# Axodesk Enterprise AI Agent Platform

This document is the production architecture for Axodesk AI Agents: a multi-tenant customer conversation automation platform across WhatsApp, Instagram, Messenger, Email, and future Webchat.

## 1. Full System Architecture Diagram

```text
Customer Channels
 WhatsApp / Instagram / Messenger / Email / Webchat
        |
        v
Provider Webhooks -> Inbound Normalizer -> Message + Conversation Store
        |                         |
        |                         +-> Socket.IO realtime inbox events
        v
BullMQ ai-agent-runtime queue  <---- idempotency + rate limits + DLQ
        |
        v
Agent Runtime Engine
  1 load tenant/workspace config
  2 load active agent version
  3 load contact + conversation history
  4 classify intent
  5 retrieve short/long memory
  6 retrieve RAG knowledge chunks
  7 decide actions
  8 execute allowed tools
  9 generate grounded reply
 10 validate guardrails
 11 send/approval/handoff
 12 write run logs + analytics + billing
        |
        +--------------------+
        |                    |
        v                    v
AI Gateway             Tool Registry
 OpenAI/Cohere          createLead
 Anthropic/Claude       assignConversation
 Gemini                 updateContactField
 retries/failover       changeLifecycleStage
 timeout/accounting     triggerWorkflow
                        escalateHuman
        |
        v
Knowledge Service
 Uploads / URLs / FAQs / Catalogs
        |
        v
BullMQ ai-knowledge queue -> extract -> chunk -> embed -> pgvector
        |
        v
PostgreSQL/Supabase
 ai_agents, ai_agent_versions, ai_runs, ai_messages,
 ai_actions, ai_tool_logs, ai_memories, ai_knowledge_*,
 ai_feedback, ai_guardrails, ai_escalations, ai_usage_billing
        |
        v
Observability
 structured logs + traces + metrics + token usage + dashboards
```

## 2. NestJS Module Structure

Implemented foundation:

```text
src/modules/ai-agents
  ai-agents.module.ts
  ai-agents.controller.ts
  ai-agents.service.ts
  ai-agent-inbound.listener.ts
  dto/
  gateway/
    ai-gateway.service.ts
  runtime/
    agent-runtime.service.ts
    agent-runtime.types.ts
  knowledge/
    knowledge.service.ts
  tools/
    ai-tool-registry.service.ts
  guardrails/
    agent-guardrails.service.ts
  handoff/
    human-handoff.service.ts

src/queues/ai-agent.queue.ts
prisma/migrations/20260419090000_ai_agent_platform_foundation/migration.sql
```

Implemented worker entrypoint:

```text
src/workers/ai-agent.worker.ts
  consumes ai-agent-runtime
  calls AgentRuntimeService.runForConversation()
  writes DLQ after retry exhaustion
  run with: npm run start:ai-agent-worker

src/workers/ai-knowledge.worker.ts
  consumes ai-knowledge
  extracts text, chunks, embeds, indexes
```

## 3. PostgreSQL Schema SQL

The full SQL migration is in:

```text
prisma/migrations/20260419090000_ai_agent_platform_foundation/migration.sql
```

It creates:

```text
ai_agents
ai_agent_versions
ai_runs
ai_messages
ai_actions
ai_tool_logs
ai_memories
ai_knowledge_sources
ai_knowledge_chunks
ai_feedback
ai_guardrails
ai_escalations
ai_usage_billing
```

Key design choices:

- Every table has `workspace_id` for tenant isolation.
- Agent config is versioned. Draft and published versions are separate.
- Runtime decisions are auditable through `ai_runs`, `ai_messages`, `ai_actions`, and `ai_tool_logs`.
- Knowledge chunks use `vector(1536)` plus full-text `tsvector`.
- RLS policies use `current_setting('app.workspace_id', true)` plus an explicit bypass setting for trusted service jobs.

## 4. pgvector Strategy

MVP:

- Use one embedding dimension: `1536`.
- Default embedding model: `text-embedding-3-small`.
- Store source-level provider/model/dim in `ai_knowledge_sources`.
- Store chunk-level provider/model/dim in `ai_knowledge_chunks`.
- Use HNSW cosine index:

```sql
CREATE INDEX "ai_knowledge_chunks_embedding_hnsw_idx"
ON "ai_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;
```

Enterprise:

- Maintain embedding version metadata.
- Reindex asynchronously when changing embedding model.
- For different dimensions, create separate chunk tables or expression indexes per dimension.
- Hybrid retrieval = semantic top 20 + lexical top 20 + rerank top 6.
- Keep raw documents out of prompt context; only selected chunks enter the LLM call.

## 5. Runtime Orchestration Flow

Deterministic flow:

```text
message_received
  -> idempotency check
  -> load workspace + active agent version
  -> load contact profile + conversation history
  -> classify intent
  -> retrieve memories
  -> retrieve top knowledge chunks
  -> decide tool calls
  -> execute allowed tools with audit logs
  -> generate grounded response
  -> run guardrail validation
  -> send reply OR wait for approval OR escalate
  -> store memory updates
  -> emit analytics + usage + Socket.IO events
```

Implemented entry points:

- Inbound listener enqueues `message.inbound` into BullMQ.
- Sandbox/manual run calls `AgentRuntimeService.runForConversation()`.
- Auto-send routes through existing `ConversationsService.sendMessage()`.

## 6. Tool Calling Framework Design

Implemented secure registry:

```ts
AiToolRegistryService.execute(ctx, toolName, input)
```

Security model:

- Tool must exist in the registry.
- Tool must be present in the published agent version `tools_allowed`.
- Tool validates tenant ownership before mutating CRM/inbox/workflows.
- High-risk tools default to approval mode.
- Every execution writes `ai_tool_logs`.

Default tools:

```text
createLead()
assignConversation()
updateContactField()
changeLifecycleStage()
bookMeeting()
createTicket()
closeConversation()
triggerWorkflow()
sendTemplate()
escalateHuman()
```

Tradeoff: `bookMeeting()` and `sendTemplate()` are registered as high-risk approval tools until calendar/template adapters are wired end-to-end.

## 7. Queue Architecture Using BullMQ

Queues:

```text
ai-agent-runtime
  MESSAGE_RECEIVED
  SANDBOX_RUN
  RETRY_RUN

ai-knowledge
  INGEST_SOURCE
  CRAWL_WEBSITE
  EMBED_CHUNKS
  REINDEX_SOURCE

existing queues
  workflow
  message-processing
  outbound
  notification
```

Production queue policies:

- Job ID = deterministic idempotency key.
- Attempts: 4-5 with exponential backoff.
- DLQ: failed jobs retained for replay.
- Separate worker autoscaling by queue depth.
- Tenant-level rate limiting before LLM calls and outbound sends.
- Concurrency split: cheap classification high concurrency, LLM reply lower concurrency, knowledge ingestion isolated.

## 8. Redis Caching Strategy

Keys:

```text
ai:agent-active:{workspaceId}:{channelType}
ai:agent-version:{versionId}
ai:memory:{workspaceId}:{contactId}
ai:rag:{workspaceId}:{queryHash}
ai:rate:{workspaceId}:{provider}:{minute}
ai:dedupe:{workspaceId}:{messageId}
ai:circuit:{provider}
ai:approval:{runId}
```

TTL:

- Active agent config: 60-300s.
- Memory snapshot: 5-15m.
- RAG query cache: 5m for repeated questions.
- Dedupe keys: 24h.
- Circuit breaker keys: 30-120s.

Never cache raw secrets or full provider payloads.

## 9. Security Hardening Checklist

- Enforce `workspace_id` in every query.
- Enable RLS for AI tables and set `app.workspace_id` per request/transaction.
- Encrypt provider keys and channel credentials.
- Store prompts/version config in audit-friendly tables.
- RBAC: `AI_AGENTS_VIEW`, `AI_AGENTS_MANAGE`.
- Tool allowlist per agent version.
- Validate tool input and tenant ownership before mutation.
- Block prompt injection and data exfiltration patterns.
- Do not place secrets, access tokens, or unrelated tenant data in prompts.
- PII redaction before external LLM calls where feasible.
- Signed webhooks and durable inbound persistence.
- Audit all tool calls, approvals, escalations, publishes, and rollbacks.
- Approval mode for high-risk tools and first production rollout.
- Rate-limit by workspace, provider, and channel.

## 10. Monitoring Dashboards

Dashboards:

- AI runtime: runs/min, success %, failure %, escalations, latency p50/p95/p99.
- LLM gateway: provider errors, timeout rate, retry count, circuit breaker state.
- Token usage: prompt/completion tokens by workspace/provider/model.
- Tool actions: success %, failure %, approval %, top failing tools.
- RAG: retrieval latency, empty retrieval %, chunk hit rate, source freshness.
- Handoff: reasons, rate by agent/channel, average time to human response.
- Business: conversations handled, leads created, resolution %, CSAT, ROI estimate.
- Queue health: depth, active, delayed, failed, oldest job age, DLQ count.

Alerts:

- p95 runtime latency > SLA.
- provider failure rate > threshold.
- DLQ count increasing.
- handoff rate spike.
- token spend anomaly by workspace.
- empty RAG retrieval spike.

## 11. API Endpoints

Implemented:

```text
GET    /api/ai-agents
POST   /api/ai-agents
GET    /api/ai-agents/:agentId
PATCH  /api/ai-agents/:agentId/draft
POST   /api/ai-agents/:agentId/publish
POST   /api/ai-agents/:agentId/pause
POST   /api/ai-agents/:agentId/versions/:versionId/rollback
DELETE /api/ai-agents/:agentId

GET    /api/ai-agents/tools
GET    /api/ai-agents/knowledge-sources
POST   /api/ai-agents/knowledge-sources

POST   /api/ai-agents/:agentId/test-runs
POST   /api/ai-agents/conversations/:conversationId/enqueue
GET    /api/ai-agents/runs/:runId
POST   /api/ai-agents/feedback
GET    /api/ai-agents/analytics
```

Next endpoints:

```text
POST   /api/ai-agents/knowledge-sources/:sourceId/reindex
GET    /api/ai-agents/escalations
POST   /api/ai-agents/runs/:runId/approve
POST   /api/ai-agents/runs/:runId/reject
GET    /api/ai-agents/analytics/funnel
```

## 12. Frontend Admin Panel Flows

Create Agent Wizard:

```text
Choose template -> Name agent -> Channels -> Tone/language -> Tools -> Knowledge -> Guardrails -> Test -> Publish
```

Configure Agent:

```text
Overview
  name, status, active version, rollback
Behavior
  tone, language, system prompt, hours
Channels
  WhatsApp, Instagram, Messenger, Email, Webchat
Tools
  allowed tools, approval required, risk labels
Guardrails
  pricing, refunds, legal, medical, profanity, confidence, max replies
Versions
  draft, published, rollback
```

Knowledge Upload:

```text
Upload PDF/docs -> parse preview -> chunk settings -> index status
Website -> URL allowlist -> crawl depth -> recrawl schedule
FAQ import -> CSV/manual -> preview -> publish
Product catalog -> schema mapping -> price policy -> publish
```

Test Sandbox:

```text
Select agent draft -> select conversation/contact fixture -> type customer message
Display: intent, memory, chunks, tool plan, reply, guardrail result, cost
```

Analytics:

```text
Conversations handled
Leads created
Resolution %
CSAT
Escalation rate
Average response time
Token spend
ROI
```

## 13. Deployment Architecture

Docker:

```text
api container
worker-ai-runtime container
worker-ai-knowledge container
worker-message-processing container
worker-workflow container
worker-notifications container
postgres/supabase
redis
object storage
```

Kubernetes:

```text
Deployment/api                HPA on CPU/RPS
Deployment/ai-runtime-worker  HPA on ai-agent-runtime queue depth
Deployment/ai-knowledge-worker HPA on ai-knowledge queue depth
Deployment/outbound-worker    HPA on outbound queue depth
Stateful/Redis or managed Redis
Managed Postgres/Supabase with pgvector
External Secrets for LLM/channel credentials
Ingress + WAF + rate limits
OpenTelemetry collector
Prometheus/Grafana/Loki/Tempo
```

Operational rules:

- API pods should not do long-running crawling or embedding work.
- Runtime workers should be horizontally scalable and idempotent.
- Knowledge workers should be isolated because file parsing/crawling is bursty.
- Use blue/green or canary deployment for runtime prompt/tool changes.

## 14. Cost Optimization Strategy

- Use small/fast model for classification and routing.
- Use stronger model only for final reply or complex handoff summary.
- Cache active agent config and repeated RAG queries.
- Keep prompt context bounded: latest messages + memories + top chunks only.
- Summarize long conversations into rolling memory.
- Use hybrid retrieval before reranking.
- Enforce per-workspace budgets and rate limits.
- Track cost per run, per resolved conversation, and per lead.
- Prefer approval mode for expensive/high-risk actions during early rollout.
- Batch embeddings during ingestion.

## 15. MVP Phase vs Enterprise Phase Roadmap

MVP:

- AI tables + pgvector foundation.
- Create/configure/publish/rollback agents.
- Sandbox test run.
- Inbound enqueue.
- Runtime with intent, memory, RAG retrieval, tool decisions, guardrails, handoff.
- Tool registry for CRM/inbox/workflow actions.
- Basic analytics and usage billing rows.

Enterprise:

- Dedicated AI runtime and knowledge workers.
- Approval queue UI.
- Full website crawler and file extraction pipeline.
- Hybrid retrieval + reranking + source citations.
- Advanced prompt-injection classifier.
- LLM provider circuit breaker dashboard.
- Per-tenant budgets, quotas, and model routing policies.
- Customer-level long-term memory controls.
- Evaluation suites and golden test conversations.
- Human QA workflow, feedback training loop, and regression checks before publish.
- SOC2-grade audit exports and retention policies.
