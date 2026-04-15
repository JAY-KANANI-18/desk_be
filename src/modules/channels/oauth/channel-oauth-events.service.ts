import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from 'src/redis/redis.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  ChannelOAuthProvider,
  PendingChannelOAuthEvent,
  getPendingChannelOAuthEventsKey,
} from './channel-oauth-events.shared';

@Injectable()
export class ChannelOAuthEventsService {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly redis: RedisService,
  ) {}

  async emitConnected(input: {
    provider: ChannelOAuthProvider;
    userId: string;
    workspaceId: string;
    channel: unknown;
  }) {
    const payload = {
      eventId: randomUUID(),
      provider: input.provider,
      channel: input.channel,
      workspaceId: input.workspaceId,
    };

    await this.deliverOrQueue(input.userId, {
      event: 'channel:connected',
      payload,
    });
  }

  async emitError(input: {
    provider: ChannelOAuthProvider;
    userId: string;
    workspaceId: string;
    error: string;
  }) {
    const payload = {
      eventId: randomUUID(),
      provider: input.provider,
      error: input.error,
      workspaceId: input.workspaceId,
    };

    await this.deliverOrQueue(input.userId, {
      event: 'channel:error',
      payload,
    });
  }

  private async deliverOrQueue(
    userId: string,
    event: PendingChannelOAuthEvent,
  ) {

    console.log({deliverOrQueue:{userId,event}});
    console.log({has:await this.realtime.hasUserConnection(userId)});
    
    if (await this.realtime.hasUserConnection(userId)) {
      this.realtime.emitToUser(userId, event.event, event.payload);
      return;
    }

    const key = getPendingChannelOAuthEventsKey(userId);
    console.log({key});
    
    await this.redis.client.rpush(key, JSON.stringify(event));
    await this.redis.client.expire(key, 10 * 60);
  }
}
