import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { AppException } from './app.exception.js';

export interface RateLimitRule {
  /** Logical name, part of the Redis key, e.g. "otp:ip". */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter on Redis. One INCR per hit; the window starts on the first hit.
 * Identifiers should already be non-sensitive (hashed phone, IP).
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
    const key = `rl:${rule.name}:${identifier}`;
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, rule.windowSeconds, 'NX')
      .ttl(key)
      .exec();
    if (!results) throw new Error('Rate limiter transaction aborted');
    const count = Number(results[0]?.[1]);
    const ttl = Number(results[2]?.[1]);
    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
    };
  }

  /** Like `hit`, but throws RATE_LIMITED (429) when over the limit. */
  async consume(rule: RateLimitRule, identifier: string): Promise<void> {
    const result = await this.hit(rule, identifier);
    if (!result.allowed) {
      throw new AppException(
        ErrorCode.RATE_LIMITED,
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: result.retryAfterSeconds },
      );
    }
  }
}
