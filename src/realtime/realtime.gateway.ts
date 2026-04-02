import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from 'prisma/prisma.service';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { verifySupabaseToken } from 'src/common/guards/supabase-jwt';
import { OnEvent } from '@nestjs/event-emitter';
@WebSocketGateway({
    namespace: '/inbox',

    cors: {
        origin: '*',
    },
})
@Injectable()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    constructor(private prisma: PrismaService) { }




    async handleConnection(client: Socket) {
        try {
            const token = client.handshake.auth?.token;

            if (!token) {
                client.disconnect();
                return;
            }

            let payload: any;
            try {
                payload = await verifySupabaseToken(token);
            } catch (e) {
                throw new UnauthorizedException('Invalid token');
            }

            const email = payload.email;

            const user = await this.prisma.user.findUnique({
                where: { email },
            });

            if (!user) {
                client.disconnect();
                return;
            }

            // attach user to socket
            client.data.user = user;

            const activity = await this.prisma.userActivity.findUnique({
                where: { userId: user.id },
            });

            if (!activity) {
                await this.prisma.userActivity.create({
                    data: {
                        userId: user.id,
                        activityStatus: "online",
                        lastSeenAt: new Date(),
                    },
                });
            } else {
                if (!["away", "busy", "dnd"].includes(activity.activityStatus)) {
                    await this.prisma.userActivity.update({
                        where: { userId: user.id },
                        data: {
                            activityStatus: "online",
                            lastSeenAt: new Date(),
                        },
                    });
                }
            }

            // ✅ SEND ACKNOWLEDGEMENT
            client.emit('connection:ack', {
                status: 'connected',
                userId: user.id,
                email: user.email,
            });

            console.log(`Socket authenticated: ${user.email}`);

        } catch (err) {
            console.log("socket error", err);
            client.disconnect();
        }
    }

    handleDisconnect(client: Socket) {
        console.log('Socket disconnected:', client.id);
    }



    @SubscribeMessage('workspace:join')
    async handleJoin(
        @MessageBody() data: { workspaceId: string },
        @ConnectedSocket() client: Socket,
    ) {
        const user = client.data.user;
        console.log("TEST SOCKET MESSAGE", { data, user });


        if (!user) {
            client.disconnect();
            return;
        }

        const membership = await this.prisma.workspaceMember.findFirst({
            where: {
                workspaceId: data.workspaceId,
                userId: user.id,
                status: 'active',
            },
        });

        if (!membership) {
            return; // silently ignore
        }

        client.join(`workspace:${data.workspaceId}`);

        console.log(
            `User ${user.email} joined workspace:${data.workspaceId}`,
        );
        return { success: true, message: `Joined workspace ${data.workspaceId}` };
    }


    // ── Join conversation room ────────────────────────────────────────────────



    @SubscribeMessage('leave_conversation')
    handleLeave(
        @MessageBody() data: { conversationId: string },
        @ConnectedSocket() client: Socket,
    ) {
        client.leave(`conversation:${data.conversationId}`);
        return { status: 'ok' };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Internal EventEmitter2 → Socket.io bridge
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * New inbound message (from InboundService)
     * → push to workspace room (conversation list badges)
     * → push to conversation room (chat timeline)
     */
    @OnEvent('message.inbound')
    handleInboundMessage(event: {
        workspaceId: string;
        conversationId: string;
        message: any;
    }) {
        // Conversation room — live chat area
        this.server
            .to(`conversation:${event.conversationId}`)
            .emit('message.upsert', event.message);

        // Workspace room — conversation list (unread badges, reorder)
        this.server
            .to(`workspace:${event.workspaceId}`)
            .emit('message.upsert', event.message);
    }

    /**
     * New outbound message (from ConversationsService.sendMessage)
     */
    @OnEvent('message.outbound')
    handleOutboundMessage(event: {
        workspaceId: string;
        conversationId: string;
        message: any;
    }) {
        this.server
            .to(`conversation:${event.conversationId}`)
            .emit('message.upsert', event.message);

        this.server
            .to(`workspace:${event.workspaceId}`)
            .emit('message.upsert', event.message);
    }

    /**
     * Message status updated (delivered / read / failed)
     * Pushed by OutboundProcessor when provider acks / webhook arrives.
     */
    @OnEvent('message.status_updated')
    handleMessageStatus(event: {
        workspaceId: string;
        conversationId: string;
        messageId: string;
        status: string;
    }) {
        this.server
            .to(`workspace:${event.workspaceId}`)
            .emit('message.status_updated', {
                messageId: event.messageId,
                conversationId: event.conversationId,
                status: event.status,
            });
    }

    /**
     * Any ConversationActivity created (assign, status change, note, etc.)
     * → push to conversation room as an activity timeline item
     */
    @OnEvent('activity.upsert')
    handleActivity(event: {
        workspaceId: string;
        conversationId: string;
        activity: any;
    }) {
        const timelineItem = {
            id: event.activity.id,
            type: 'activity' as const,
            timestamp: event.activity.createdAt,
            activity: event.activity,
        };

        this.server
            .to(`workspace:${event.workspaceId}`)
            .emit('activity', timelineItem);
    }

    /**
     * Conversation updated (status, assignee, priority, unread count)
     * → push to workspace room so conversation list row updates live
     */
    @OnEvent('conversation.updated')
    handleConversationUpdated(conv: any) {
        if (!conv?.workspaceId) return;
        this.server
            .to(`workspace:${conv.workspaceId}`)
            .emit('conversation.upsert', conv);
    }

    @OnEvent('conversation.created')
    handleConversationCreated(conv: any) {
        if (!conv?.workspaceId) return;
        this.server
            .to(`workspace:${conv.workspaceId}`)
            .emit('conversation.upsert', conv);
    }
}