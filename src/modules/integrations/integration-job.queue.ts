import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { connection } from '../../queues/connection';

export interface IntegrationJobQueueOptions {
  attempts?: number;
  delay?: number;
}

@Injectable()
export class IntegrationJobQueue {
  private readonly queue = new Queue('integration-jobs', {
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

  async add(jobId: string, options: IntegrationJobQueueOptions = {}) {
    await this.queue.add(
      'process-job',
      { jobId },
      {
        jobId,
        attempts: options.attempts,
        delay: options.delay,
      },
    );
  }
}
