import { Queue } from 'bullmq';
import { connection } from './connection';

export const messageQueue = new Queue('messages', {
    connection,
    defaultJobOptions: {
        attempts: 5, // max retries
        backoff: {
            type: 'exponential',
            delay: 3000, // 3 seconds initial
        },
        removeOnComplete: true,
        removeOnFail: false, // keep failed for inspection
    },
});
// connection: {
//     url: process.env.REDIS_URL,
//   }