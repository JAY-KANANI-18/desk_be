import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { connection } from '../../queues/connection';

@Injectable()
export class ImportExportQueue {
  private readonly queue = new Queue('import-export', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 200,
      removeOnFail: 200,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    },
  });

  async add(jobId: string) {
    await this.queue.add(
      'process-job',
      { jobId },
      {
        jobId,
      },
    );
  }
}
