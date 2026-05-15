import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { connection } from '../../queues/connection';
import { IntegrationsService } from './integrations.service';

@Injectable()
export class IntegrationJobWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(IntegrationJobWorker.name);
  private worker?: Worker;

  constructor(private readonly integrations: IntegrationsService) {}

  onApplicationBootstrap() {
    this.worker = new Worker(
      'integration-jobs',
      async (job: Job<{ jobId: string }>) => {
        await this.integrations.processIntegrationJob(job.data.jobId);
      },
      {
        connection,
        concurrency: Number(process.env.INTEGRATION_JOB_WORKER_CONCURRENCY ?? 1),
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.debug(`Integration job ${job.id} completed`);
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Integration job ${job?.id} failed: ${error.message}`);
    });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }
}
