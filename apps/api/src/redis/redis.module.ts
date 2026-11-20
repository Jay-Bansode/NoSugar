import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';

export const REDIS = Symbol('REDIS');

const PING_TIMEOUT_MS = 1000;

function createRedis(env: Env): Redis {
  const logger = new Logger('Redis');
  const client = new Redis(env.REDIS_URL, {
    // Fail fast instead of hanging requests while Redis is down.
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: true,
  });
  // Without a listener ioredis would crash the process on connection errors.
  let lastError = '';
  client.on('error', (err: Error) => {
    if (err.message !== lastError) {
      lastError = err.message;
      logger.warn(`Redis connection error: ${err.message}`);
    }
  });
  client.on('ready', () => {
    lastError = '';
  });
  return client;
}

@Injectable()
export class RedisHealth implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async isHealthy(): Promise<boolean> {
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS).unref(),
        ),
      ]);
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: createRedis, inject: [ENV] }, RedisHealth],
  exports: [REDIS, RedisHealth],
})
export class RedisModule {}
