import { Queue } from 'bullmq';
import { connection } from './connection';

export const messageProcessingQueue = new Queue('message-processing', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
