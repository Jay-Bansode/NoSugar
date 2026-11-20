/**
 * OTP login end to end against real Postgres + Redis (CLAUDE.md §6 Login).
 * Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { authTokensSchema, errorResponseSchema, meSchema } from '@brand/shared';
import type { Redis } from 'ioredis';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { OTP_SENDER, type OtpSender } from '../src/modules/auth/otp-sender.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { REDIS } from '../src/redis/redis.module.js';
import { TEST_ENV } from './helpers/env.js';

class CapturingOtpSender implements OtpSender {
  readonly sent = new Map<string, string>();
  async send(phone: string, code: string): Promise<void> {
    this.sent.set(phone, code);
  }
}

const sender = new CapturingOtpSender();
const createdPhones: string[] = [];
let app: NestExpressApplication;

function newPhone(): { input: string; e164: string } {
  const local = `9${randomInt(100_000_000, 999_999_999)}`;
  const e164 = `+91${local}`;
  createdPhones.push(e164);
  // Typed the way a customer might, to exercise normalisation.
  return { input: `${local.slice(0, 5)} ${local.slice(5)}`, e164 };
}

/** Each test gets its own client IP so per-IP rate limits never leak between tests or runs. */
function newIp(): string {
  return `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

function post(path: string, ip: string) {
  return request(app.getHttpServer()).post(path).set('X-Forwarded-For', ip);
}

async function requestCode(phone: { input: string; e164: string }, ip: string): Promise<string> {
  await post('/v1/auth/otp', ip).send({ phone: phone.input }).expect(202);
  const code = sender.sent.get(phone.e164);
  if (!code) throw new Error('no OTP captured');
  return code;
}

function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

function refreshCookie(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith('brand_rt='));
}

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    TRUST_PROXY: '1',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(OTP_SENDER)
    .useValue(sender)
    .compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
});

afterAll(async () => {
  // Sessions cascade with the user.
  await app.get(PrismaService).user.deleteMany({ where: { phone: { in: createdPhones } } });
  await app.close();
});

describe('readiness', () => {
  it('reports database and redis up', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });
});

describe('OTP login (app client)', () => {
  it('logs in, reads /me, refreshes with rotation', async () => {
    const ip = newIp();
    const phone = newPhone();
    const code = await requestCode(phone, ip);

    const verify = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code, client: 'app' })
      .expect(200);
    expect(verify.headers['cache-control']).toBe('no-store');
    const tokens = authTokensSchema.parse(verify.body);
    expect(tokens.refreshToken).toBeDefined();
    expect(tokens.user.phone).toBe(phone.e164);
    expect(refreshCookie(verify)).toBeUndefined();

    const me = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
    expect(meSchema.parse(me.body)).toMatchObject({ id: tokens.user.id, phone: phone.e164 });

    const refreshed = await post('/v1/auth/refresh', ip)
      .send({ client: 'app', refreshToken: tokens.refreshToken })
      .expect(200);
    const next = authTokensSchema.parse(refreshed.body);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.user.id).toBe(tokens.user.id);
  });

  it('returns the same customer on a second login', async () => {
    const ip = newIp();
    const phone = newPhone();
    const first = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code: await requestCode(phone, ip), client: 'app' })
      .expect(200);
    const second = await loginAgain(phone, ip);
    expect(second.user.id).toBe(first.body.user.id);
  });

  it('detects refresh-token reuse and revokes the whole session family', async () => {
    const ip = newIp();
    const phone = newPhone();
    const login = authTokensSchema.parse(
      (
        await post('/v1/auth/verify', ip)
          .send({ phone: phone.input, code: await requestCode(phone, ip), client: 'app' })
          .expect(200)
      ).body,
    );
    const rotated = authTokensSchema.parse(
      (
        await post('/v1/auth/refresh', ip)
          .send({ client: 'app', refreshToken: login.refreshToken })
          .expect(200)
      ).body,
    );

    // Attacker replays the old token → rejected, and the family is revoked…
    await post('/v1/auth/refresh', ip)
      .send({ client: 'app', refreshToken: login.refreshToken })
      .expect(401);
    // …so the legitimate, newer token no longer works either.
    await post('/v1/auth/refresh', ip)
      .send({ client: 'app', refreshToken: rotated.refreshToken })
      .expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const ip = newIp();
    const phone = newPhone();
    const login = authTokensSchema.parse(
      (
        await post('/v1/auth/verify', ip)
          .send({ phone: phone.input, code: await requestCode(phone, ip), client: 'app' })
          .expect(200)
      ).body,
    );
    await post('/v1/auth/logout', ip)
      .send({ client: 'app', refreshToken: login.refreshToken })
      .expect(204);
    await post('/v1/auth/refresh', ip)
      .send({ client: 'app', refreshToken: login.refreshToken })
      .expect(401);
  });
});

describe('OTP login (web client)', () => {
  it('uses an httpOnly cookie for the refresh token, never the body', async () => {
    const ip = newIp();
    const phone = newPhone();
    const verify = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code: await requestCode(phone, ip), client: 'web' })
      .expect(200);
    expect(verify.body.refreshToken).toBeUndefined();
    const cookie = refreshCookie(verify);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);

    const cookiePair = cookie!.split(';')[0]!;
    const refreshed = await post('/v1/auth/refresh', ip)
      .set('Cookie', cookiePair)
      .send({ client: 'web' })
      .expect(200);
    const rotatedPair = refreshCookie(refreshed)!.split(';')[0]!;
    expect(rotatedPair).not.toBe(cookiePair);

    const logout = await post('/v1/auth/logout', ip)
      .set('Cookie', rotatedPair)
      .send({ client: 'web' })
      .expect(204);
    expect(refreshCookie(logout)).toMatch(/Expires=Thu, 01 Jan 1970/);
    await post('/v1/auth/refresh', ip)
      .set('Cookie', rotatedPair)
      .send({ client: 'web' })
      .expect(401);
  });

  it('refresh without a cookie → 401', async () => {
    await post('/v1/auth/refresh', newIp()).send({ client: 'web' }).expect(401);
  });
});

describe('OTP rules', () => {
  it('rejects a wrong code and says how many attempts remain', async () => {
    const ip = newIp();
    const phone = newPhone();
    const code = await requestCode(phone, ip);
    const res = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code: wrongCode(code), client: 'app' })
      .expect(401);
    expect(errorResponseSchema.parse(res.body).error).toMatchObject({
      code: 'OTP_INVALID',
      details: { attemptsRemaining: 4 },
    });
  });

  it('burns the code after 5 wrong attempts, even if the right code follows', async () => {
    const ip = newIp();
    const phone = newPhone();
    const code = await requestCode(phone, ip);
    for (let i = 1; i <= 4; i++) {
      await post('/v1/auth/verify', ip)
        .send({ phone: phone.input, code: wrongCode(code), client: 'app' })
        .expect(401);
    }
    const fifth = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code: wrongCode(code), client: 'app' })
      .expect(429);
    expect(fifth.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');

    const correct = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code, client: 'app' })
      .expect(401);
    expect(correct.body.error.code).toBe('OTP_EXPIRED');
  });

  it('codes are single-use', async () => {
    const ip = newIp();
    const phone = newPhone();
    const code = await requestCode(phone, ip);
    await post('/v1/auth/verify', ip).send({ phone: phone.input, code, client: 'app' }).expect(200);
    const again = await post('/v1/auth/verify', ip)
      .send({ phone: phone.input, code, client: 'app' })
      .expect(401);
    expect(again.body.error.code).toBe('OTP_EXPIRED');
  });

  it('verifying without requesting a code → OTP_EXPIRED', async () => {
    const res = await post('/v1/auth/verify', newIp())
      .send({ phone: newPhone().input, code: '123456', client: 'app' })
      .expect(401);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('enforces the 30-second resend cooldown', async () => {
    const ip = newIp();
    const phone = newPhone();
    await requestCode(phone, ip);
    const res = await post('/v1/auth/otp', ip).send({ phone: phone.input }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it('limits OTP requests per IP (20 per hour)', async () => {
    const ip = newIp();
    for (let i = 0; i < 20; i++) {
      await post('/v1/auth/otp', ip).send({ phone: newPhone().input }).expect(202);
    }
    const res = await post('/v1/auth/otp', ip).send({ phone: newPhone().input }).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

/** Logs the same phone in again, clearing resend cooldowns the way 30 seconds would. */
async function loginAgain(phone: { input: string; e164: string }, ip: string) {
  const redis = app.get<Redis>(REDIS);
  for (const key of await redis.keys('otp:cd:*')) await redis.del(key);
  const res = await post('/v1/auth/verify', ip)
    .send({ phone: phone.input, code: await requestCode(phone, ip), client: 'app' })
    .expect(200);
  return authTokensSchema.parse(res.body);
}
