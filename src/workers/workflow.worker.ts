import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { workflowQueue } from '../queues/workflow.queue';

const prisma = new PrismaClient();

const worker = new Worker(
    'workflow',
    async job => {
        const { workspaceId, contactId, nodes } = job.data;

        for (const node of nodes) {
            if (node.type === 'wait') {
                await new Promise(resolve =>
                    setTimeout(resolve, node.delayMs),
                );
            }

            if (node.type === 'action') {
                if (node.actionType === 'assign_team') {
                    await prisma.contact.update({
                        where: { id: contactId },
                        data: { teamId: node.teamId },
                    });
                }

                if (node.actionType === 'assign_agent') {
                    await prisma.contact.update({
                        where: { id: contactId },
                        data: { assigneeId: node.userId },
                    });
                }
            }
        }
    },
    {
        connection: {
            host: '127.0.0.1',
            port: 6379,
        },
    },
);

console.log('Workflow worker running...');