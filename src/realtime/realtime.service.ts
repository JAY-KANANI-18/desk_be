import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { toJsonSafe } from '../common/utils/json-safe';
import { RedisService } from '../redis/redis.service';

export const getRealtimeUserSocketsKey = (userId: string) =>
  `realtime:user:${userId}:sockets`;

@Injectable()
export class RealtimeService {
    private readonly debugEnabled = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.NOTIFICATION_DEBUG || '').toLowerCase(),
    );

    constructor(
      private gateway: RealtimeGateway,
      private redis: RedisService,
    ) { }

async hasUserConnection(userId: string) {
  const redisKey = getRealtimeUserSocketsKey(userId);

  const socketIds = await this.redis.client.smembers(redisKey).catch(() => []);
  this.logDebug('has-user-connection:redis', {
    userId,
    redisKey,
    socketIds,
  });
  if (socketIds.length > 0 && this.gateway.server) {
    const liveSockets = await this.gateway.server.in(`user:${userId}`).fetchSockets();
    const liveIds = new Set(liveSockets.map(s => s.id));

    const staleIds = socketIds.filter(id => !liveIds.has(id));
    if (staleIds.length) {
      await this.redis.client.srem(redisKey, ...staleIds);
      this.logDebug('has-user-connection:stale-removed', {
        userId,
        staleIds,
      });
    }

    if (liveSockets.length > 0) {
      await this.redis.client.expire(redisKey, 60); // short TTL
      this.logDebug('has-user-connection:live', {
        userId,
        liveSocketIds: liveSockets.map((socket) => socket.id),
      });
      return true;
    }
  }

  if (!this.gateway.server) {
    this.logDebug('has-user-connection:no-gateway', {
      userId,
    });
    return false;
  }

  const sockets = await this.gateway.server.in(`user:${userId}`).fetchSockets();
  if (sockets.length > 0) {
    await this.redis.client.del(redisKey);
    await this.redis.client.sadd(redisKey, ...sockets.map(s => s.id));
    await this.redis.client.expire(redisKey, 60);
    this.logDebug('has-user-connection:repopulated', {
      userId,
      socketIds: sockets.map((socket) => socket.id),
    });
    return true;
  }

  await this.redis.client.del(redisKey);
  this.logDebug('has-user-connection:none', {
    userId,
  });
  return false;
}
    emitToUser(userId: string, event: string, payload: any) {
        this.gateway.server
            .to(`user:${userId}`)
            .emit(event, toJsonSafe(payload));
    }

    emitToWorkspace(workspaceId: string, event: string, payload: any) {
        this.gateway.server
            .to(`workspace:${workspaceId}`)
            .emit(event, toJsonSafe(payload));
    }

    private logDebug(event: string, details?: unknown) {
        if (!this.debugEnabled) {
            return;
        }

        console.info(`[NotificationDebug][RealtimeService] ${event}`, details ?? '');
    }
}
