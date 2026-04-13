import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { connection } from '../../queues/connection';
import { ImportExportService } from './import-export.service';

@Injectable()
export class ImportExportWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ImportExportWorker.name);
  private worker?: Worker;

  constructor(private readonly importExportService: ImportExportService) {}

  onApplicationBootstrap() {
    this.worker = new Worker(
      'import-export',
      async (job: Job<{ jobId: string }>) => {
        await this.importExportService.processJob(job.data.jobId);
      },
      {
        connection,
        concurrency: Number(process.env.IMPORT_EXPORT_WORKER_CONCURRENCY ?? 2),
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Import/export job ${job?.id} failed: ${error.message}`);
    });
  }

  async onApplicationShutdown() {
    await this.worker?.close();
  }
}
