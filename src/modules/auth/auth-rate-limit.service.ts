import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class AuthRateLimitService {
  constructor(private readonly redis: RedisService) {}

  async consume(key: string, maxAttempts: number, windowSeconds: number) {
    const ttlKey = `auth:rate:${key}`;
    const current = await this.redis.client.incr(ttlKey);

    if (current === 1) {
      await this.redis.client.expire(ttlKey, windowSeconds);
    }

    const ttl = await this.redis.client.ttl(ttlKey);

    return {
      allowed: current <= maxAttempts,
      current,
      remaining: Math.max(0, maxAttempts - current),
      resetInSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }

  async clear(key: string) {
    await this.redis.client.del(`auth:rate:${key}`);
  }
}

