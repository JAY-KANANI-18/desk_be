import { Queue } from 'bullmq';

export const messageQueue = new Queue('messages', {
    connection: {
        host: '127.0.0.1',
        port: 6379,
    },
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