import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { RedisService } from 'src/redis/redis.service';
import { connection } from './connection';

const prisma = new PrismaClient();
const redis = new RedisService();

const worker = new Worker(
    'sla',
    async job => {
        const { workspaceId, conversationId } = job.data;

        const conversation = await prisma.conversation.findFirst({
            where: { id: conversationId, workspaceId },
            include: {
                contact: true,
            },
        });

        if (!conversation) return;

        // If already assigned and replied → ignore
        if (conversation.contact.status !== 'open') return;

        // Mark breached
        await prisma.conversation.update({
            where: { id: conversationId },
            data: {
                slaBreached: true,
                priority: 'high',
            },
        });

        await redis.increment(
            `dashboard:${workspaceId}`,
            'slaBreached',
            1,
        );
        console.log('SLA breached for conversation:', conversationId);
    },
    {
        connection: connection
    },
);

console.log('SLA worker running...');