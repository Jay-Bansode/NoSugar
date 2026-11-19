import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { errorResponseSchema } from '@brand/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_ENV } from './helpers/env.js';

// Runs with no database or Redis: nothing listens on port 1, which proves the app still boots
// and reports dependencies down instead of hanging or crashing.
describe('API (e2e, no dependencies)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const env = loadEnv({
      ...TEST_ENV,
      APP_VERSION: '9.9.9',
      DATABASE_URL: 'postgresql://brand:brand@127.0.0.1:1/brand',
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = configureApp(
      moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health → 200 without a token', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '9.9.9' });
    expect(new Date(res.body.time).toISOString()).toBe(res.body.time);
  });

  it('does not send X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /v1/health/ready → 503 naming the dependencies that are down', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(503);
    expect(errorResponseSchema.parse(res.body).error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Not ready',
      details: { checks: { database: 'down', redis: 'down' } },
    });
  });

  it('protected routes need a token (deny by default)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/me').expect(401);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed and forged tokens', async () => {
    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Bearer nope')
      .expect(401);
    const forged =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwic2lkIjoieSIsInR5cCI6ImFjY2VzcyJ9.c2lnbmF0dXJl';
    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('validates the OTP request body before touching Redis', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/otp')
      .send({ phone: '12345' })
      .expect(400);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('VALIDATION_FAILED');
  });

  it('routes live only under /v1', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('unknown routes return the standard error shape', async () => {
    const res = await request(app.getHttpServer()).get('/v1/nope').expect(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});
