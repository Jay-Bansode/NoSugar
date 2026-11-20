/**
 * GET /v1/serviceability over HTTP with real Redis (cache) and settings, and a counting fake
 * provider standing in for Shiprocket. Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { errorResponseSchema, serviceabilitySchema } from '@brand/shared';
import type { Redis } from 'ioredis';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import {
  SERVICEABILITY_PROVIDER,
  type ServiceabilityProvider,
  type ServiceabilityRequest,
  type ServiceabilityResult,
} from '../src/modules/fulfilment/serviceability.provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { REDIS } from '../src/redis/redis.module.js';
import { TEST_ENV } from './helpers/env.js';

class FakeProvider implements ServiceabilityProvider {
  calls: ServiceabilityRequest[] = [];
  next: ServiceabilityResult | Error = {
    serviceable: true,
    codAvailable: true,
    minDays: 2,
    maxDays: 4,
    city: 'Pune',
    state: 'Maharashtra',
  };
  async check(req: ServiceabilityRequest): Promise<ServiceabilityResult> {
    this.calls.push(req);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

const provider = new FakeProvider();
let app: NestExpressApplication;
let prisma: PrismaService;
let settingsBackup: { key: string; value: unknown }[] = [];
const usedPincodes: string[] = [];

/** A fresh PIN per test so earlier runs' cache entries never interfere. */
function pin(): string {
  const p = String(randomInt(200000, 699999));
  usedPincodes.push(p);
  return p;
}

const ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
const get = (pincode: string, clientIp = ip()) =>
  request(app.getHttpServer())
    .get(`/v1/serviceability?pincode=${encodeURIComponent(pincode)}`)
    .set('X-Forwarded-For', clientIp);

async function setSetting(key: string, value: unknown) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as never },
    update: { value: value as never },
  });
}

async function restoreSettings() {
  await prisma.setting.deleteMany({});
  if (settingsBackup.length) {
    await prisma.setting.createMany({
      data: settingsBackup.map((s) => ({ key: s.key, value: s.value as never })),
    });
  }
}

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    TRUST_PROXY: '1',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(SERVICEABILITY_PROVIDER)
    .useValue(provider)
    .compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
  prisma = app.get(PrismaService);
  settingsBackup = (await prisma.setting.findMany()).map((s) => ({ key: s.key, value: s.value }));
});

beforeEach(async () => {
  provider.calls = [];
  provider.next = {
    serviceable: true,
    codAvailable: true,
    minDays: 2,
    maxDays: 4,
    city: 'Pune',
    state: 'Maharashtra',
  };
  await restoreSettings();
});

afterAll(async () => {
  await restoreSettings();
  const redis = app.get<Redis>(REDIS);
  for (const p of usedPincodes) {
    for (const key of await redis.keys(`svc:v1:${p}:*`)) await redis.del(key);
  }
  await app.close();
});

describe('GET /v1/serviceability', () => {
  it('is public and adds dispatch days to the courier estimate', async () => {
    const pincode = pin();
    const res = await get(pincode).expect(200);
    expect(serviceabilitySchema.parse(res.body)).toEqual({
      pincode,
      serviceable: true,
      codAvailable: true,
      estimatedDelivery: { minDays: 3, maxDays: 5 }, // +1 dispatch day (default setting)
      city: 'Pune',
      state: 'Maharashtra',
    });
    expect(provider.calls).toEqual([{ pincode, weightGrams: 500 }]);
  });

  it('caches courier answers but applies settings on every call', async () => {
    const pincode = pin();
    await get(pincode).expect(200);
    await setSetting('cod.enabled', false);
    await setSetting('shipping.dispatch_days', 2);
    const res = await get(pincode).expect(200);
    expect(provider.calls).toHaveLength(1); // second answer came from the cache
    expect(res.body).toMatchObject({
      codAvailable: false,
      estimatedDelivery: { minDays: 4, maxDays: 6 },
    });
  });

  it('reports not serviceable without an estimate', async () => {
    provider.next = {
      serviceable: false,
      codAvailable: true,
      minDays: null,
      maxDays: null,
      city: null,
      state: null,
    };
    const res = await get(pin()).expect(200);
    expect(res.body).toMatchObject({
      serviceable: false,
      codAvailable: false,
      estimatedDelivery: null,
    });
  });

  it('returns 503 when the courier check fails, and does not cache the failure', async () => {
    const pincode = pin();
    provider.next = new Error('Shiprocket timed out');
    const res = await get(pincode).expect(503);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.error.message).not.toContain('Shiprocket');

    provider.next = {
      serviceable: true,
      codAvailable: false,
      minDays: 5,
      maxDays: 6,
      city: null,
      state: null,
    };
    await get(pincode).expect(200);
    expect(provider.calls).toHaveLength(2);
  });

  it.each(['040001', '4000', 'abcdef', ''])(
    'rejects PIN %j with VALIDATION_FAILED',
    async (bad) => {
      const res = await get(bad).expect(400);
      expect(errorResponseSchema.parse(res.body).error.code).toBe('VALIDATION_FAILED');
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('rate-limits per IP (60 per 10 minutes)', async () => {
    const clientIp = ip();
    const pincode = pin();
    for (let i = 0; i < 60; i++) await get(pincode, clientIp).expect(200);
    const res = await get(pincode, clientIp).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
