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
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@WebSocketGateway({
  namespace: '/widget',
  cors: { origin: '*' }, // tighten to allowedOrigins from channel config in prod
})
@Injectable()
export class WidgetGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(WidgetGateway.name);

  // sessionId → socket.id map for direct pushes
  private sessionSockets = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async handleConnection(client: Socket) {
    const { token: widgetToken, sessionId } = client.handshake.auth;

    if (!widgetToken || !sessionId) {
      client.disconnect();
      return;
    }

    // Verify widget token
    const channel = await this.prisma.channel.findFirst({
      where: {
        type: 'webchat',
        status: 'connected',
        identifier: widgetToken,
      },
    });

    if (!channel) {
        this.logger.warn(`Widget connection rejected: invalid token ${widgetToken}`);
      client.disconnect();
      return;
    }

    client.data.channel = channel;
    client.data.sessionId = sessionId;

    // Join room keyed by sessionId
    client.join(`widget:${sessionId}`);
    this.sessionSockets.set(sessionId, client.id);
    this.logger.log(`Widget connected: session=${sessionId} channel=${channel.id}`);

    // Find existing conversation and send history
    // const conversation = await this.prisma.conversation.findFirst({
    //   where: {
    //     channelId: channel.id,
    //     metadata: { path: ['sessionId'], equals: sessionId },
    //     status: { not: 'closed' },
    //   },
    //   orderBy: { createdAt: 'desc' },
    // });

    // if (conversation) {
    //   const messages = await this.prisma.message.findMany({
    //     where: { conversationId: conversation.id },
    //     orderBy: { createdAt: 'asc' },
    //     take: 50,
    //     include: { attachments: true },
    //   });
    //   client.emit('history', messages);
    }

    // client.emit('connection:ack', { sessionId, status: 'connected' });
    // this.logger.log(`Widget connected: session=${sessionId} channel=${channel.id}`);
//   }

  handleDisconnect(client: Socket) {

    const sessionId = client.data?.sessionId;
    if (sessionId) this.sessionSockets.delete(sessionId);
    this.logger.log(`Widget disconnected: session=${sessionId}`);
  }

  // ── Customer sends a message via socket ───────────────────────────────────
  // (alternative to HTTP POST /webchat/message — widget can use either)
  @SubscribeMessage('message.send')
  async handleMessage(
    @MessageBody() data: { text: string; messageType?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { channel, sessionId } = client.data;
    if (!channel || !sessionId) return { error: 'Not authenticated' };

    // Emit to InboundService via event so the same pipeline runs
    this.events.emit('webchat.inbound', {
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      sessionId,
      text: data.text,
      messageType: data.messageType ?? 'text',
    });

    return { ok: true };
  }

  // ── Customer typing indicator ──────────────────────────────────────────────
  @SubscribeMessage('typing')
  handleTyping(
    @MessageBody() data: { isTyping: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const { channel, sessionId } = client.data;
    if (!channel) return;

    // Forward to agent room in the /inbox namespace
    // RealtimeGateway will pick this up if you add the handler there
    this.events.emit('webchat.typing', {
      workspaceId: channel.workspaceId,
      sessionId,
      isTyping: data.isTyping,
    });
  }

  // ── Push outbound (agent → customer) message to widget ────────────────────
  @OnEvent('message.outbound')
  handleOutbound(event: {
    workspaceId: string;
    conversationId: string;
    message: any;
  }) {
    this.logger.debug(" Received outbound event for conversation " + event.conversationId);
    console.dir({message: event.message}, { depth: null });
    
    if (event.message?.channelType !== 'webchat') return;

    const sessionId = event?.message?.metadata?.contactIdentifier;
    this.logger.debug(`Outbound message for session ${sessionId} conv=${event.conversationId} msg=${event.message.id}`);
    if (!sessionId) {
      // Fallback: look up sessionId from conversation metadata
      this.pushToConversation(event.conversationId, event.message);
      return;
    }

    this.server
      .to(`widget:${sessionId}`)
      .emit('message.new', event.message);
  }

  // ── Push typing from agent to customer ────────────────────────────────────
  @OnEvent('webchat.agent_typing')
  handleAgentTyping(event: { sessionId: string; isTyping: boolean }) {
    this.server
      .to(`widget:${event.sessionId}`)
      .emit('typing', { isTyping: event.isTyping });
  }

  // ── Fallback: resolve sessionId from DB then push ─────────────────────────
  private async pushToConversation(conversationId: string, message: any) {
    // const conversation = await this.prisma.conversation.findUnique({
    //   where: { id: conversationId },
    //   select: { metadata: true },
    // });
    // const sessionId = (conversation?.metadata as any)?.sessionId;
    // if (sessionId) {
    //   this.server.to(`widget:${sessionId}`).emit('message.new', message);
    // }
  }
}