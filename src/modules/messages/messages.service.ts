import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { messageQueue } from '../../queues/message.queue';
import { EventEmitter2 } from '@nestjs/event-emitter';
// import { ChannelService } from '../channels/channel.service';

@Injectable()
export class MessagesService {
    constructor(private prisma: PrismaService,

        private     eventEmitter: EventEmitter2

        // private channelService: ChannelService,


    ) { }

    async create(workspaceId: string, conversationId: string, authorId: string, dto: any) {
        console.log({ workspaceId, conversationId, authorId, dto });

        const conversation = await this.prisma.conversation.findFirst({
            where: { id: conversationId, workspaceId },
            include: { contact: {
                include: {assignee: true}
            } },
        });

        if (!conversation) throw new NotFoundException('Conversation not found');

        // 1️⃣ Create message (always first)
        console.log({ dto });
        const message = await this.prisma.message.create({
            data: {
                ...dto,
                workspaceId,
                conversationId,
                authorId,
                status: dto.direction === 'outgoing' ? 'pending' : 'delivered',
            },
        });

        this.eventEmitter.emit("message.created", {
            userId: conversation.contact.assigneeId,
            messageId: message.id,
            workspaceId,
            email: conversation.contact.assignee.email,
        });

        // 2️⃣ Update conversation last message
        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: {
                lastMessageId: message.id,
                lastMessageAt: new Date(),
                unreadCount:
                    dto.direction === 'incoming'
                        ? { increment: 1 }
                        : undefined,
            },
        });

        // 3️⃣ If outgoing → enqueue background job
        if (dto.direction === 'outgoing') {
            await messageQueue.add('send-message', {
                messageId: message.id,
            });
        }
        // 3️⃣ If incoming → handle workflow
        // if (dto.direction === 'incoming') {
        //     await this.workflowEngine.handleMessageReceived({
        //         workspaceId,
        //         conversationId,
        //         messageText: dto.text ?? '',
        //     });
        // }
        // 3️⃣ If outgoing → update SLA
        if (dto.direction === 'outgoing') {
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: {
                    slaBreached: false,
                    slaDueAt: null,
                },
            });
        }
        // 4️⃣ If outgoing → update first response time
        if (dto.direction === 'outgoing') {
            const conversation = await this.prisma.conversation.findUnique({
                where: { id: conversationId },
            });

            if (!conversation?.firstResponseAt) {
                await this.prisma.conversation.update({
                    where: { id: conversationId },
                    data: {
                        firstResponseAt: new Date(),
                    },
                });
            }
        }

        return message;
    }

    async readMessages(workspaceId: string, conversationId: string) {


        await this.prisma.conversation.update({
            where: { id: conversationId },
            data: {
                unreadCount: 0,
            },
        });
        const messages = await this.prisma.message.findMany({
            where: { conversationId, workspaceId, status: { in: ['delivered', 'pending'] } },
        });

        if (!messages.length) return [];

        await this.prisma.message.updateMany({
            where: { conversationId, workspaceId },
            data: { status: 'read' },


        });


        return messages;
    }

    async findAll(workspaceId: string, conversationId: string) {
        return this.prisma.message.findMany({
            where: { workspaceId, conversationId },
            orderBy: { createdAt: 'asc' },
            include:{
                messageAttachments: true,
                
            }
        });
    }
}