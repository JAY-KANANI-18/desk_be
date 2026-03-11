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

@WebSocketGateway({
    cors: {
        origin: '*',
    },
})
@Injectable()
export class RealtimeGateway
    implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    constructor(private prisma: PrismaService) { }

    async handleConnection(client: Socket) {
        try {
            const token = client.handshake.auth?.token;
            console.log("SOCKET TRY TO CONNECT", { token });

            if (!token) {
                client.disconnect();
                return;
            }
            let payload: any;
            try {
                payload = await verifySupabaseToken(token);
            } catch (e) {
                console.log({ e });

                throw new UnauthorizedException('Invalid token');
            }
            console.log({ socketpayload: payload });

            const userId = payload.sub;
            const email = payload.email;


            // 🔥 TEMP: Replace later with real JWT validation
            const mockUserId = '11111111-1111-1111-1111-111111111111';

            const user = await this.prisma.user.findUnique({
                where: { email: email },
            });

            console.log({ user });

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
                // Only auto-set online if user wasn't manually away/busy/dnd
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

            console.log('Socket authenticated:', user.email);
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
    }
}