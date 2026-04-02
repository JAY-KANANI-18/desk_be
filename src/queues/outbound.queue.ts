// src/queues/outbound.queue.ts
import { Queue } from 'bullmq';

export const outboundQueue = new Queue('outbound', {
    connection: {
        host: "127.0.0.1",
        port: 6379
    },
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
});

export interface OutboundJob {
    workspaceId: string;
    conversationId: string;
    channelId: string;
    text: string;
    authorId: string | null;
    attachments: any[];
    runId?: string;
    stepId?: string;
    metadata?:any;
}