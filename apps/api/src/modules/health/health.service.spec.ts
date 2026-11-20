import { ErrorCode } from '@brand/shared';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppException } from '../../common/app.exception.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RedisHealth } from '../../redis/redis.module.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  let service: HealthService;
  let dbHealthy: boolean;
  let redisHealthy: boolean;

  beforeEach(async () => {
    dbHealthy = true;
    redisHealthy = true;
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: ENV, useValue: { APP_VERSION: '1.2.3' } as Env },
        { provide: PrismaService, useValue: { isHealthy: async () => dbHealthy } },
        { provide: RedisHealth, useValue: { isHealthy: async () => redisHealthy } },
      ],
    }).compile();
    service = moduleRef.get(HealthService);
  });

  it('reports ok with version and ISO time', () => {
    const now = new Date('2026-11-19T10:00:00.000Z');
    expect(service.check(now)).toEqual({
      status: 'ok',
      version: '1.2.3',
      time: '2026-11-19T10:00:00.000Z',
    });
  });

  it('is ready when every dependency is up', async () => {
    await expect(service.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it.each([
    [false, true, { database: 'down', redis: 'up' }],
    [true, false, { database: 'up', redis: 'down' }],
  ])('throws SERVICE_UNAVAILABLE (503) naming what is down', async (db, redis, checks) => {
    dbHealthy = db;
    redisHealthy = redis;
    const err = await service.ready().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect((err as AppException).getStatus()).toBe(503);
    expect((err as AppException).details).toEqual({ checks });
  });
});
