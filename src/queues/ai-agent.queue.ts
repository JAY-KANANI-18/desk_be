import { Queue } from 'bullmq';
import { aiAgentsDebug } from 'src/modules/ai-agents/ai-agents-debug.logger';
import { connection } from './connection';

export const AI_AGENT_QUEUE_NAME = 'ai-agent-runtime';
export const AI_KNOWLEDGE_QUEUE_NAME = 'ai-knowledge';

export interface AiAgentRuntimeJob {
  type: 'MESSAGE_RECEIVED' | 'SANDBOX_RUN' | 'RETRY_RUN';
  workspaceId: string;
  conversationId?: string;
  messageId?: string;
  agentId?: string;
  runId?: string;
  channelId?: string;
  channelType?: string;
  idempotencyKey: string;
  receivedAt: string;
  payload?: Record<string, any>;
}

export interface AiKnowledgeJob {
  type: 'INGEST_SOURCE' | 'CRAWL_WEBSITE' | 'EMBED_CHUNKS' | 'REINDEX_SOURCE';
  workspaceId: string;
  sourceId: string;
  idempotencyKey: string;
  payload?: Record<string, any>;
}

export const aiAgentQueue = new Queue<AiAgentRuntimeJob>(AI_AGENT_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 2500 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
});

export const aiKnowledgeQueue = new Queue<AiKnowledgeJob>(AI_KNOWLEDGE_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: Number(process.env.AI_KNOWLEDGE_QUEUE_ATTEMPTS || 3),
    backoff: { type: 'exponential', delay: Number(process.env.AI_KNOWLEDGE_QUEUE_BACKOFF_MS || 10000) },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
});

aiAgentsDebug.log('queue.bootstrap', 'AI queues initialized', {
  queues: [AI_AGENT_QUEUE_NAME, AI_KNOWLEDGE_QUEUE_NAME],
  connection,
  runtimeDefaults: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 2500 },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
  knowledgeDefaults: {
    attempts: Number(process.env.AI_KNOWLEDGE_QUEUE_ATTEMPTS || 3),
    backoff: { type: 'exponential', delay: Number(process.env.AI_KNOWLEDGE_QUEUE_BACKOFF_MS || 10000) },
    removeOnComplete: 500,
    removeOnFail: 2000,
  },
});
