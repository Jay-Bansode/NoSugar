import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ENV, type Env } from '../../config/env.js';
import { REDIS } from '../../redis/redis.module.js';
import { ServiceabilityController } from './serviceability.controller.js';
import {
  SERVICEABILITY_PROVIDER,
  type ServiceabilityProvider,
  ShiprocketServiceabilityProvider,
  StubServiceabilityProvider,
} from './serviceability.provider.js';
import { ServiceabilityService } from './serviceability.service.js';
import { ShiprocketClient, type TokenStore } from './shiprocket.client.js';

const TOKEN_KEY = 'shiprocket:token';

function redisTokenStore(redis: Redis): TokenStore {
  return {
    get: () => redis.get(TOKEN_KEY),
    set: async (token, ttl) => {
      await redis.set(TOKEN_KEY, token, 'EX', ttl);
    },
    clear: async () => {
      await redis.del(TOKEN_KEY);
    },
  };
}

function serviceabilityProvider(env: Env, redis: Redis): ServiceabilityProvider {
  if (env.SHIPPING_PROVIDER === 'stub') return new StubServiceabilityProvider();
  // Env validation guarantees these are set for "shiprocket".
  const client = new ShiprocketClient(
    {
      baseUrl: env.SHIPROCKET_API_BASE,
      email: env.SHIPROCKET_API_EMAIL!,
      password: env.SHIPROCKET_API_PASSWORD!,
    },
    redisTokenStore(redis),
  );
  return new ShiprocketServiceabilityProvider(client, env.SHIPROCKET_PICKUP_PINCODE!);
}

/** Shiprocket integration (CLAUDE.md §6 Fulfilment). Slice 6: serviceability only. */
@Module({
  controllers: [ServiceabilityController],
  providers: [
    ServiceabilityService,
    RateLimiterService,
    { provide: SERVICEABILITY_PROVIDER, useFactory: serviceabilityProvider, inject: [ENV, REDIS] },
  ],
  exports: [ServiceabilityService],
})
export class FulfilmentModule {}
