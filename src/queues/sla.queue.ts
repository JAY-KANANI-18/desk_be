import { Queue } from 'bullmq';

export const slaQueue = new Queue('sla', {
    connection: {
        host: '127.0.0.1',
        port: 6379,
    },
});