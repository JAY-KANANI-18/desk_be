import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { RedisService } from '../redis/redis.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationWorker } from './notification.worker';
import { WorkflowEngineService } from '../modules/workflows/workflow-engine.service';
import { createWorkflowWorker } from './workflow.worker';

async function start() {
  const prisma = new PrismaClient();
  const redis = new RedisService();
  const events = new EventEmitter2();
  const notificationDebugEnabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
  );

  new NotificationWorker(redis, prisma);
  console.log('Notification worker started');
  console.log('Notification debug logging', notificationDebugEnabled ? 'enabled' : 'disabled');

  const workflowEngine = new WorkflowEngineService(prisma as any, redis);
  const workflowWorker = createWorkflowWorker(workflowEngine);

  workflowWorker.on('completed', (job) => {
    console.log(`Workflow job completed: ${job.id} [${job.name}]`);
  });

  workflowWorker.on('failed', (job, err) => {
    console.error(`Workflow job failed: ${job?.id} [${job?.name}]`, err.message);
  });

  workflowWorker.on('error', (err) => {
    console.error('Workflow worker error:', err);
  });

  console.log('Workflow worker started');

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received - shutting down workers...`);

    await workflowWorker.close();
    await prisma.$disconnect();
    redis.client.disconnect();

    console.log('Workers shut down cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Failed to start workers:', err);
  process.exit(1);
});
