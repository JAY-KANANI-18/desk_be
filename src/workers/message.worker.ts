import { Worker } from 'bullmq';
// import { PrismaClient } from '@prisma/client';
// import { ChannelService } from '../modules/channels/channel.service';
// import { ChannelAdaptersRegistry } from '../modules/channels/channel-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { connection } from './connection';

const prisma = new PrismaService();
// const registry = new ChannelAdaptersRegistry();
// const channelService = new ChannelService(prisma, registry);

const worker = new Worker(
    'messages',
    async job => {
        const { messageId } = job.data;

        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: {
                conversation: {
                    include: { contact: true },
                },
            },
        });

        if (!message) return;

        try {
            // const result = await channelService.sendMessage({
            //     messageId: message.id,
            // });

            // await prisma.message.update({
            //     where: { id: message.id },
            //     data: {
            //         status: 'sent',
            //         channelMsgId: result.externalId,
            //     },
            // });

        } catch (error: any) {

            const isPermanent =
                error.response?.status === 400 ||
                error.response?.status === 403;

            if (isPermanent) {
                await prisma.message.update({
                    where: { id: message.id },
                    data: { status: 'failed' },
                });

                return; // DO NOT throw → no retry
            }

            if (job.attemptsMade >= job.opts.attempts! - 1) {
                await prisma.message.update({
                    where: { id: message.id },
                    data: { status: 'failed' },
                });
            }

            throw error;
        }
    },
    {
        connection: connection
    },
);

worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed permanently`, err);
});

console.log('Message worker running...');