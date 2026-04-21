import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { SessionContext } from './auth.types';

@Injectable()
export class AuthSessionCacheService {
  constructor(private readonly redis: RedisService) {}

  private sessionKey(sessionId: string) {
    return `auth:session:${sessionId}`;
  }

  async get(sessionId: string): Promise<SessionContext | null> {
    const value = await this.redis.client.get(this.sessionKey(sessionId));
    return value ? (JSON.parse(value) as SessionContext) : null;
  }

  async set(context: SessionContext, ttlSeconds?: number) {
    const seconds = ttlSeconds ?? Math.max(
      60,
      Math.floor((new Date(context.expiresAt).getTime() - Date.now()) / 1000),
    );

    await this.redis.client.set(
      this.sessionKey(context.sessionId),
      JSON.stringify(context),
      'EX',
      seconds,
    );
  }

  async delete(sessionId: string) {
    await this.redis.client.del(this.sessionKey(sessionId));
  }
}

