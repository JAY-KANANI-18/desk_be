// src/activity/activity.gateway.ts
//
// WebSocket gateway that forwards ConversationActivity events
// to connected clients in real time.
//
// When ActivityService.record() writes a row it emits 'activity.created'.
// This gateway listens for that internal event and pushes it to the
// appropriate room: `conversation:{conversationId}`
//
// FE joins the room when it opens a conversation, leaves when it navigates away.

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors:      { origin: '*' },
  namespace: '/inbox',
})
export class ActivityGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ActivityGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  // Client sends: { conversationId: 'uuid' }
  @SubscribeMessage('join_conversation')
  handleJoin(
    @MessageBody() data: { conversationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `conversation:${data.conversationId}`;
    client.join(room);
    this.logger.debug(`${client.id} joined ${room}`);
    return { joined: room };
  }

  @SubscribeMessage('leave_conversation')
  handleLeave(
    @MessageBody() data: { conversationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `conversation:${data.conversationId}`;
    client.leave(room);
    return { left: room };
  }

  // ─── Internal event handler ───────────────────────────────────────────────
  // Fired by ActivityService.record() via EventEmitter2

  @OnEvent('activity.created')
  handleActivityCreated(payload: {
    workspaceId:    string;
    conversationId: string;
    activity:       any;
  }) {
    const room = `conversation:${payload.conversationId}`;

    // Push to all clients watching this conversation
    this.server.to(room).emit('activity', {
      conversationId: payload.conversationId,
      activity:       payload.activity,
    });

    // Also push to the workspace room so conversation list can update badges
    this.server.to(`workspace:${payload.workspaceId}`).emit('conversation_updated', {
      conversationId: payload.conversationId,
      type:           'activity',
      eventType:      payload.activity.eventType,
    });
  }

  // ─── Also broadcast new messages (already in your codebase?) ─────────────

  @OnEvent('message.inbound')
  handleInboundMessage(payload: {
    workspaceId:    string;
    conversationId: string;
    message:        any;
  }) {
    const room = `conversation:${payload.conversationId}`;
    this.server.to(room).emit('message', {
      conversationId: payload.conversationId,
      message:        payload.message,
    });
  }
}