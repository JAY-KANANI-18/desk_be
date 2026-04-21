import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { aiAgentsDebug } from '../modules/ai-agents/ai-agents-debug.logger';
import { AiAgentsFeatureService } from '../modules/ai-agents/ai-agents-feature.service';
import { KnowledgeService } from '../modules/ai-agents/knowledge/knowledge.service';
import { AgentRuntimeService } from '../modules/ai-agents/runtime/agent-runtime.service';
import { AI_AGENT_QUEUE_NAME, AI_KNOWLEDGE_QUEUE_NAME, AiAgentRuntimeJob, AiKnowledgeJob } from '../queues/ai-agent.queue';
import { connection } from '../queues/connection';
import { AiAgentWorkerModule } from './ai-agent-worker.module';

function numberEnv(name: string, fallback: number, min = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function configureWorkerDatabasePool() {
  process.env.PRISMA_CONNECTION_LIMIT ||= process.env.AI_AGENT_DB_CONNECTION_LIMIT || '2';
  process.env.PRISMA_POOL_TIMEOUT ||= process.env.AI_AGENT_DB_POOL_TIMEOUT || '10';
}

async function start() {
  configureWorkerDatabasePool();
  const runtimeConcurrency = numberEnv('AI_AGENT_WORKER_CONCURRENCY', 2);
  const knowledgeConcurrency = numberEnv('AI_KNOWLEDGE_WORKER_CONCURRENCY', 1);
  const runtimeLimiterMax = numberEnv('AI_AGENT_WORKER_RATE_LIMIT_MAX', 60);
  const runtimeLimiterDuration = numberEnv('AI_AGENT_WORKER_RATE_LIMIT_DURATION_MS', 60000);
  const knowledgeLimiterMax = numberEnv('AI_KNOWLEDGE_WORKER_RATE_LIMIT_MAX', 20);
  const knowledgeLimiterDuration = numberEnv('AI_KNOWLEDGE_WORKER_RATE_LIMIT_DURATION_MS', 60000);

  aiAgentsDebug.log('worker.bootstrap', 'AI agent worker boot start', {
    queueNames: [AI_AGENT_QUEUE_NAME, AI_KNOWLEDGE_QUEUE_NAME],
    redis: connection,
    debugEnabled: aiAgentsDebug.enabled(),
    verbose: aiAgentsDebug.verbose(),
    concurrency: runtimeConcurrency,
    knowledgeConcurrency,
    dbPool: {
      connectionLimit: process.env.PRISMA_CONNECTION_LIMIT,
      poolTimeout: process.env.PRISMA_POOL_TIMEOUT,
    },
    limiter: {
      max: runtimeLimiterMax,
      duration: runtimeLimiterDuration,
    },
  });
  const app = await NestFactory.createApplicationContext(AiAgentWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  const feature = app.get(AiAgentsFeatureService);
  if (!feature.isEnabled()) {
    aiAgentsDebug.warn('worker.bootstrap', 'AI agent worker disabled by feature flag', {
      AI_AGENTS_ENABLED: process.env.AI_AGENTS_ENABLED,
      FEATURE_AI_AGENTS_ENABLED: process.env.FEATURE_AI_AGENTS_ENABLED,
    });
    console.log('AI agent worker disabled by AI_AGENTS_ENABLED=false');
    await app.close();
    return;
  }

  const runtime = app.get(AgentRuntimeService);
  const knowledge = app.get(KnowledgeService);

  const runtimeWorker = new Worker<AiAgentRuntimeJob>(
    AI_AGENT_QUEUE_NAME,
    async (job) => {
      const data = job.data;
      aiAgentsDebug.log('worker.job', 'processing start', {
        jobId: job.id,
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
        data,
      });

      if (data.type === 'MESSAGE_RECEIVED' || data.type === 'RETRY_RUN') {
        if (!data.conversationId) throw new Error('conversationId is required for AI runtime job');
        const result = await runtime.runForConversation({
          workspaceId: data.workspaceId,
          conversationId: data.conversationId,
          messageId: data.messageId,
          agentId: data.agentId,
          mode: 'auto',
          idempotencyKey: data.idempotencyKey,
        });
        aiAgentsDebug.log('worker.job', 'runtime result', {
          jobId: job.id,
          jobName: job.name,
          type: data.type,
          result,
        });
        return result;
      }

      if (data.type === 'SANDBOX_RUN') {
        if (!data.conversationId || !data.agentId) {
          throw new Error('conversationId and agentId are required for sandbox AI runtime job');
        }
        const result = await runtime.runForConversation({
          workspaceId: data.workspaceId,
          conversationId: data.conversationId,
          agentId: data.agentId,
          mode: 'sandbox',
          sandboxMessage: data.payload?.message,
          idempotencyKey: data.idempotencyKey,
        });
        aiAgentsDebug.log('worker.job', 'sandbox runtime result', {
          jobId: job.id,
          jobName: job.name,
          result,
        });
        return result;
      }

      aiAgentsDebug.warn('worker.job', 'unsupported job type', {
        jobId: job.id,
        jobName: job.name,
        data,
      });
      throw new Error(`Unsupported AI runtime job type: ${(data as any).type}`);
    },
    {
      connection,
      concurrency: runtimeConcurrency,
      limiter: {
        max: runtimeLimiterMax,
        duration: runtimeLimiterDuration,
      },
    },
  );

  const knowledgeWorker = new Worker<AiKnowledgeJob>(
    AI_KNOWLEDGE_QUEUE_NAME,
    async (job) => {
      const data = job.data;
      aiAgentsDebug.log('knowledge.worker.job', 'processing start', {
        jobId: job.id,
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
        data,
      });
      await job.updateProgress({ status: 'started', sourceId: data.sourceId, type: data.type });

      if (data.type === 'INGEST_SOURCE' || data.type === 'CRAWL_WEBSITE' || data.type === 'REINDEX_SOURCE') {
        const result = await knowledge.ingestSource(data.workspaceId, data.sourceId, data.payload);
        await job.updateProgress({ status: 'completed', sourceId: data.sourceId, type: data.type, result });
        aiAgentsDebug.log('knowledge.worker.job', 'ingest result', {
          jobId: job.id,
          jobName: job.name,
          type: data.type,
          result,
        });
        return result;
      }

      if (data.type === 'EMBED_CHUNKS') {
        const result = await knowledge.embedChunksForSource(data.workspaceId, data.sourceId);
        await job.updateProgress({ status: 'completed', sourceId: data.sourceId, type: data.type, result });
        aiAgentsDebug.log('knowledge.worker.job', 'embed chunks result', {
          jobId: job.id,
          jobName: job.name,
          result,
        });
        return result;
      }

      aiAgentsDebug.warn('knowledge.worker.job', 'unsupported job type', {
        jobId: job.id,
        jobName: job.name,
        data,
      });
      throw new Error(`Unsupported AI knowledge job type: ${(data as any).type}`);
    },
    {
      connection,
      concurrency: knowledgeConcurrency,
      limiter: {
        max: knowledgeLimiterMax,
        duration: knowledgeLimiterDuration,
      },
    },
  );

  runtimeWorker.on('active', (job) => {
    aiAgentsDebug.log('runtime.worker.event', 'job active', {
      jobId: job.id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      data: job.data,
    });
  });

  runtimeWorker.on('progress', (job, progress) => {
    aiAgentsDebug.log('runtime.worker.event', 'job progress', {
      jobId: job.id,
      jobName: job.name,
      progress,
    });
  });

  runtimeWorker.on('stalled', (jobId) => {
    aiAgentsDebug.warn('runtime.worker.event', 'job stalled', { jobId });
  });

  runtimeWorker.on('completed', (job) => {
    aiAgentsDebug.log('runtime.worker.event', 'job completed', {
      jobId: job.id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      returnvalue: job.returnvalue,
      data: job.data,
    });
    console.log(`AI agent job completed: ${job.id} [${job.name}]`);
  });

  runtimeWorker.on('failed', (job, err) => {
    aiAgentsDebug.error('runtime.worker.event', 'job failed', err, {
      jobId: job?.id,
      jobName: job?.name,
      attemptsMade: job?.attemptsMade,
      failedReason: job?.failedReason,
      stacktrace: job?.stacktrace,
      data: job?.data,
    });
    console.error(`AI agent job failed: ${job?.id} [${job?.name}]`, err.message);
  });

  runtimeWorker.on('error', (err) => {
    aiAgentsDebug.error('runtime.worker.event', 'worker error', err);
    console.error('AI agent worker error:', err);
  });

  knowledgeWorker.on('active', (job) => {
    aiAgentsDebug.log('knowledge.worker.event', 'job active', {
      jobId: job.id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      data: job.data,
    });
  });

  knowledgeWorker.on('progress', (job, progress) => {
    aiAgentsDebug.log('knowledge.worker.event', 'job progress', {
      jobId: job.id,
      jobName: job.name,
      progress,
    });
  });

  knowledgeWorker.on('stalled', (jobId) => {
    aiAgentsDebug.warn('knowledge.worker.event', 'job stalled', { jobId });
  });

  knowledgeWorker.on('completed', (job) => {
    aiAgentsDebug.log('knowledge.worker.event', 'job completed', {
      jobId: job.id,
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      returnvalue: job.returnvalue,
      data: job.data,
    });
    console.log(`AI knowledge job completed: ${job.id} [${job.name}]`);
  });

  knowledgeWorker.on('failed', (job, err) => {
    aiAgentsDebug.error('knowledge.worker.event', 'job failed', err, {
      jobId: job?.id,
      jobName: job?.name,
      attemptsMade: job?.attemptsMade,
      failedReason: job?.failedReason,
      stacktrace: job?.stacktrace,
      data: job?.data,
    });
    console.error(`AI knowledge job failed: ${job?.id} [${job?.name}]`, err.message);
  });

  knowledgeWorker.on('error', (err) => {
    aiAgentsDebug.error('knowledge.worker.event', 'worker error', err);
    console.error('AI knowledge worker error:', err);
  });

  const shutdown = async (signal: string) => {
    aiAgentsDebug.warn('worker.bootstrap', 'shutdown signal received', { signal });
    console.log(`${signal} received - shutting down AI agent workers...`);
    await runtimeWorker.close();
    await knowledgeWorker.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  aiAgentsDebug.log('worker.bootstrap', 'AI agent worker started', {
    queueNames: [AI_AGENT_QUEUE_NAME, AI_KNOWLEDGE_QUEUE_NAME],
    concurrency: runtimeConcurrency,
    knowledgeConcurrency,
  });
  console.log('AI agent runtime and knowledge workers started');
}

start().catch((err) => {
  aiAgentsDebug.error('worker.bootstrap', 'failed to start AI agent worker', err);
  console.error('Failed to start AI agent worker:', err);
  process.exit(1);
});
