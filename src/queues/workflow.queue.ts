import { Queue } from 'bullmq';

export const workflowQueue = new Queue('workflow', {
    connection: {
        host: '127.0.0.1',
        port: 6379,
    },
});