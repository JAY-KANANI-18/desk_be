import { PrismaClient } from '@prisma/client';
import { RedisService } from '../redis/redis.service';
import { SupabaseService } from '../supdabse/supabase.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationWorker } from './notification.worker';
import { WorkflowEngineService } from '../modules/workflows/workflow-engine.service';
import { createWorkflowWorker } from './workflow.worker';

async function start() {
  const prisma = new PrismaClient();
  const redis = new RedisService();
  const supabase = new SupabaseService();
  const events = new EventEmitter2();

  // ── Notification worker ──────────────────────────────────────────────────
  new NotificationWorker(redis, supabase);
  console.log('✅ Notification worker started');

  // ── Workflow worker ──────────────────────────────────────────────────────
  const workflowEngine = new WorkflowEngineService(prisma as any, redis);
  const workflowWorker = createWorkflowWorker(workflowEngine);

  workflowWorker.on('completed', (job) => {
    console.log(`✅ Workflow job completed: ${job.id} [${job.name}]`);
  });

  workflowWorker.on('failed', (job, err) => {
    console.error(`❌ Workflow job failed: ${job?.id} [${job?.name}]`, err.message);
  });

  workflowWorker.on('error', (err) => {
    console.error('❌ Workflow worker error:', err);
  });

  console.log('✅ Workflow worker started');

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down workers...`);

    await workflowWorker.close();
    await prisma.$disconnect();
    redis.client.disconnect();

    console.log('Workers shut down cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Failed to start workers:', err);
  process.exit(1);
});