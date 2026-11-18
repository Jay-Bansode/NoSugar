import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { errorResponseSchema } from '@brand/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';

describe('API (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_VERSION: '9.9.9',
      DATABASE_URL: 'postgresql://brand:brand@localhost:5432/brand',
      REDIS_URL: 'redis://localhost:6379',
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

  it('GET /v1/health → 200', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '9.9.9' });
    expect(new Date(res.body.time).toISOString()).toBe(res.body.time);
  });

  it('does not send X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('routes live only under /v1', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('unknown routes return the standard error shape', async () => {
    const res = await request(app.getHttpServer()).get('/v1/nope').expect(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});
