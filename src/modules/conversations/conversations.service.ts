import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { slaQueue } from '../../queues/sla.queue';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class ConversationsService {
    constructor(private prisma: PrismaService,
        private realtime: RealtimeService,
        private redis: RedisService,) { }


    async create(workspaceId: string, contactId: string) {
        const conversation = await this.prisma.conversation.create({
            data: {
                workspaceId,
                contactId,
            },
        });


        // Increment total and open counts
        await this.redis.increment(
            `dashboard:${workspaceId}`,
            'total',
            1,
        );

        // Increment open count
        await this.redis.increment(
            `dashboard:${workspaceId}`,
            'open',
            1,
        );

        // Example SLA: 5 minutes for first reply
        const delayMs = 5 * 60 * 1000;

        await slaQueue.add(
            'sla-breach',
            {
                workspaceId,
                conversationId: conversation.id,
            },
            {
                delay: delayMs,
                removeOnComplete: true,
            },
        );

        // If no assignee manually set
        // if (!conversation.assigneeId) {
        //     await this.autoAssign(workspaceId, conversation.id);
        // }


        return conversation;
    }

    async findAll(workspaceId: string) {
        return this.prisma.conversation.findMany({
            where: { workspaceId },
            include: {
                contact: true,
                lastMessage: true,
                channel: true,
            },
            orderBy: { updatedAt: 'desc' },
        });
    }



    // async updateStatus(workspaceId: string, conversationId: string, status: string) {
    //     const conversation = await this.prisma.conversation.findFirst({
    //         where: { id: conversationId, workspaceId },
    //     });

    //     if (!conversation) {
    //         throw new NotFoundException('Conversation not found');
    //     }

    //     return this.prisma.conversation.update({
    //         where: { id: conversationId },
    //         data: { status },
    //     });
    // }

    // async resolve(workspaceId: string, conversationId: string) {




    //     const updated = await this.prisma.conversation.update({
    //         where: { id: conversationId },
    //         data: {
    //             status: 'resolved',
    //             resolvedAt: new Date(),
    //         },
    //     });

    //     await this.redis.increment(
    //         `dashboard:${workspaceId}`,
    //         'open',
    //         -1,
    //     );

    //     await this.redis.increment(
    //         `dashboard:${workspaceId}`,
    //         'resolved',
    //         1,
    //     );
    //     return updated;
    // }
}