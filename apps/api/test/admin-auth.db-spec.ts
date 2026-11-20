/**
 * Admin sign-in (password + authenticator app), sessions, role guard and audit log against
 * real Postgres + Redis. Run: pnpm --filter @brand/api test:db
 */
import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  type AdminLoginChallenge,
  adminLoginChallengeSchema,
  type AdminRole,
  type AdminTokens,
  adminTokensSchema,
  auditLogEntrySchema,
  errorResponseSchema,
} from '@brand/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { AdminController } from '../src/modules/admin/admin.guard.js';
import { AdminSessionService } from '../src/modules/admin/admin-session.service.js';
import { AdminTokenService } from '../src/modules/admin/admin-token.service.js';
import { hashPassword } from '../src/modules/admin/password.js';
import { SecretBox } from '../src/modules/admin/secret-box.js';
import { generateTotpSecret, totpCode, totpStep } from '../src/modules/admin/totp.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';

/** Changes something but forgets the audit record: the interceptor must catch it. */
@AdminController('test-unaudited', ['owner'])
class UnauditedController {
  @Post()
  @HttpCode(200)
  change(): { ok: true } {
    return { ok: true };
  }
}

/** An /admin route someone forgot to guard with @AdminController. */
@Controller('admin/test-forgotten')
class ForgottenController {
  @Get()
  read(): { secret: true } {
    return { secret: true };
  }
}

const run = randomUUID().slice(0, 8).toLowerCase();
const PASSWORD = 'correct horse battery staple';
let app: NestExpressApplication;
let prisma: PrismaService;
const box = new SecretBox(TEST_ENV.ADMIN_TOTP_KEY);
const f = { adminIds: [] as string[], userIds: [] as string[] };

interface TestAdmin {
  id: string;
  email: string;
  secret: string;
  /** Next TOTP step to use (each code works once). */
  step: number;
}

async function createAdmin(role: AdminRole, enrolled = true): Promise<TestAdmin> {
  const email = `${role}-${run}-${randomInt(1e6)}@test.invalid`;
  const secret = generateTotpSecret();
  const admin = await prisma.adminUser.create({
    data: { email, name: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD) },
  });
  if (enrolled) {
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpSecret: box.seal(secret, admin.id), totpEnabledAt: new Date() },
    });
  }
  f.adminIds.push(admin.id);
  return { id: admin.id, email, secret, step: totpStep(new Date()) };
}

const ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
const post = (path: string) => request(app.getHttpServer()).post(path).set('X-Forwarded-For', ip());
const get = (path: string, token?: string) => {
  const r = request(app.getHttpServer()).get(path).set('X-Forwarded-For', ip());
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

function login(email: string, password = PASSWORD) {
  return post('/v1/admin/auth/login').send({ email, password });
}

/** Next unused code for this admin (current step, then the one after: both within drift). */
function nextCode(admin: TestAdmin, secret = admin.secret): string {
  return totpCode(secret, admin.step++);
}

async function signIn(admin: TestAdmin): Promise<{ tokens: AdminTokens; cookie: string }> {
  const challenge = adminLoginChallengeSchema.parse((await login(admin.email).expect(200)).body);
  const res = await post('/v1/admin/auth/totp')
    .send({ challengeToken: challenge.challengeToken, code: nextCode(admin) })
    .expect(200);
  return {
    tokens: adminTokensSchema.parse(res.body),
    cookie: refreshCookie(res.headers['set-cookie']),
  };
}

function refreshCookie(header: string | string[] | undefined): string {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = cookies.find((c) => c.startsWith('brand_admin_rt='));
  if (!cookie) throw new Error('No admin refresh cookie');
  return cookie;
}
const cookiePair = (cookie: string) => cookie.split(';')[0]!;

const code = (res: request.Response) => errorResponseSchema.parse(res.body).error.code;
const auditActions = async (adminId: string) =>
  (await prisma.auditLog.findMany({ where: { adminUserId: adminId }, orderBy: { id: 'asc' } })).map(
    (r) => r.action,
  );

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    TRUST_PROXY: '1',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env)],
    controllers: [UnauditedController, ForgottenController],
  }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  // audit_log is append-only by trigger: turn triggers off for this transaction only.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.auditLog.deleteMany({
      where: { OR: [{ adminUserId: { in: f.adminIds } }, { entityId: { in: f.adminIds } }] },
    });
    await tx.adminSession.deleteMany({ where: { adminUserId: { in: f.adminIds } } });
    await tx.adminUser.deleteMany({ where: { id: { in: f.adminIds } } });
  });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await app.close();
});

describe('first sign-in sets up the authenticator app', () => {
  it('returns a key, accepts its code, and signs in', async () => {
    const admin = await createAdmin('operations', false);
    const res = await login(admin.email.toUpperCase()).expect(200);
    const challenge: AdminLoginChallenge = adminLoginChallengeSchema.parse(res.body);
    expect(challenge.next).toBe('enrol');
    expect(challenge.enrolment?.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(challenge.enrolment?.otpauthUrl).toContain(`secret=${challenge.enrolment?.secret}`);
    expect(res.headers['cache-control']).toBe('no-store');

    // A code from the wrong key doesn't enrol.
    const wrong = await post('/v1/admin/auth/totp')
      .send({
        challengeToken: challenge.challengeToken,
        code: totpCode(generateTotpSecret(), admin.step),
      })
      .expect(401);
    expect(code(wrong)).toBe('TOTP_INVALID');

    const ok = await post('/v1/admin/auth/totp')
      .send({
        challengeToken: challenge.challengeToken,
        code: nextCode(admin, challenge.enrolment!.secret),
      })
      .expect(200);
    const tokens = adminTokensSchema.parse(ok.body);
    expect(tokens.admin).toMatchObject({ email: admin.email, role: 'operations' });
    const cookie = refreshCookie(ok.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/v1\/admin\/auth/);
    expect(ok.body).not.toHaveProperty('refreshToken');

    const me = await get('/v1/admin/me', tokens.accessToken).expect(200);
    expect(me.body).toEqual(tokens.admin);
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.totpEnabledAt).not.toBeNull();
    expect(row.totpSecret).not.toContain(challenge.enrolment!.secret); // encrypted at rest
    expect(await auditActions(admin.id)).toEqual([
      'admin.totp_failed',
      'admin.totp_enrolled',
      'admin.login',
    ]);

    // From now on it asks for a code, without a new key.
    const again = adminLoginChallengeSchema.parse((await login(admin.email).expect(200)).body);
    expect(again).toMatchObject({ next: 'verify', enrolment: null });
  });
});

describe('password step', () => {
  it('gives the same answer for an unknown email and a wrong password', async () => {
    const admin = await createAdmin('support');
    const unknown = await login(`nobody-${run}@test.invalid`).expect(401);
    const wrong = await login(admin.email, 'not the password').expect(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(code(wrong)).toBe('INVALID_CREDENTIALS');
  });

  it('locks after five failures, and only says so to someone with the password', async () => {
    const admin = await createAdmin('support');
    for (let i = 0; i < 5; i++) await login(admin.email, `wrong ${i}`).expect(401);
    const locked = await login(admin.email).expect(423);
    expect(code(locked)).toBe('ACCOUNT_LOCKED');
    expect(errorResponseSchema.parse(locked.body).error.details).toMatchObject({
      retryAfterSeconds: expect.any(Number),
    });
    expect(code(await login(admin.email, 'still wrong').expect(401))).toBe('INVALID_CREDENTIALS');
    const actions = await auditActions(admin.id);
    expect(actions.filter((a) => a === 'admin.login_failed')).toHaveLength(5);

    // Unlocked once the time has passed.
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    await login(admin.email).expect(200);
  });

  it('refuses disabled admins as if the password were wrong', async () => {
    const admin = await createAdmin('support');
    const { tokens } = await signIn(admin);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { disabledAt: new Date() } });
    expect(code(await login(admin.email).expect(401))).toBe('INVALID_CREDENTIALS');
    // Their access token stops working at once.
    await get('/v1/admin/me', tokens.accessToken).expect(401);
  });
});

describe('code step', () => {
  it('refuses a wrong code, a reused code and an expired challenge', async () => {
    const admin = await createAdmin('operations');
    const challenge = adminLoginChallengeSchema.parse((await login(admin.email).expect(200)).body);
    const wrong = String((Number(totpCode(admin.secret, admin.step)) + 1) % 1e6).padStart(6, '0');
    expect(
      code(
        await post('/v1/admin/auth/totp')
          .send({ challengeToken: challenge.challengeToken, code: wrong })
          .expect(401),
      ),
    ).toBe('TOTP_INVALID');

    const used = nextCode(admin);
    await post('/v1/admin/auth/totp')
      .send({ challengeToken: challenge.challengeToken, code: used })
      .expect(200);
    const replay = await post('/v1/admin/auth/totp')
      .send({ challengeToken: challenge.challengeToken, code: used })
      .expect(401);
    expect(code(replay)).toBe('TOTP_INVALID');

    const bogus = await post('/v1/admin/auth/totp')
      .send({
        challengeToken: `${challenge.challengeToken.slice(0, -4)}AAAA`,
        code: nextCode(admin),
      })
      .expect(401);
    expect(code(bogus)).toBe('UNAUTHORIZED');
  });

  it('a challenge dies when the password changes', async () => {
    const admin = await createAdmin('operations');
    const challenge = adminLoginChallengeSchema.parse((await login(admin.email).expect(200)).body);
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordChangedAt: new Date() },
    });
    await post('/v1/admin/auth/totp')
      .send({ challengeToken: challenge.challengeToken, code: nextCode(admin) })
      .expect(401);
  });
});

describe('roles and token separation', () => {
  it('lets owners read the audit log and refuses other roles', async () => {
    const owner = await createAdmin('owner');
    const support = await createAdmin('support');
    const { tokens: ownerTokens } = await signIn(owner);
    const { tokens: supportTokens } = await signIn(support);

    const res = await get(
      `/v1/admin/audit-log?adminUserId=${support.id}`,
      ownerTokens.accessToken,
    ).expect(200);
    const entries = (res.body as { data: unknown[] }).data.map((e) => auditLogEntrySchema.parse(e));
    expect(entries[0]).toMatchObject({ action: 'admin.login', admin: { id: support.id } });

    expect(code(await get('/v1/admin/audit-log', supportTokens.accessToken).expect(403))).toBe(
      'FORBIDDEN',
    );
    await get('/v1/admin/me', supportTokens.accessToken).expect(200);
  });

  it('never accepts a customer token on admin routes, or an admin token on customer routes', async () => {
    const user = await prisma.user.create({
      data: { phone: `+9194${randomInt(10_000_000, 99_999_999)}` },
    });
    f.userIds.push(user.id);
    const { token: customerToken } = await app
      .get(TokenService)
      .signAccessToken({ userId: user.id, sessionId: randomUUID() });
    const admin = await createAdmin('owner');
    const { tokens } = await signIn(admin);

    await get('/v1/admin/me', customerToken).expect(401);
    await get('/v1/admin/me').expect(401);
    await get('/v1/me', tokens.accessToken).expect(401);
  });

  it('refuses an /admin route that forgot @AdminController, even to customers', async () => {
    const user = await prisma.user.create({
      data: { phone: `+9194${randomInt(10_000_000, 99_999_999)}` },
    });
    f.userIds.push(user.id);
    const { token } = await app
      .get(TokenService)
      .signAccessToken({ userId: user.id, sessionId: randomUUID() });
    expect(code(await get('/v1/admin/test-forgotten', token).expect(403))).toBe('FORBIDDEN');
  });
});

describe('sessions', () => {
  it('rotates the refresh cookie, keeps the original expiry, and catches reuse', async () => {
    const admin = await createAdmin('operations');
    const { tokens, cookie } = await signIn(admin);

    const refreshed = await post('/v1/admin/auth/refresh')
      .set('Cookie', cookiePair(cookie))
      .expect(200);
    const next = adminTokensSchema.parse(refreshed.body);
    expect(next.sessionExpiresAt).toBe(tokens.sessionExpiresAt);
    const nextCookie = refreshCookie(refreshed.headers['set-cookie']);
    expect(cookiePair(nextCookie)).not.toBe(cookiePair(cookie));
    await get('/v1/admin/me', next.accessToken).expect(200);

    // Replaying the old cookie revokes the whole family, including the new session.
    await post('/v1/admin/auth/refresh').set('Cookie', cookiePair(cookie)).expect(401);
    await post('/v1/admin/auth/refresh').set('Cookie', cookiePair(nextCookie)).expect(401);
    await get('/v1/admin/me', next.accessToken).expect(401);
  });

  it('signing out ends the session at once', async () => {
    const admin = await createAdmin('operations');
    const { tokens, cookie } = await signIn(admin);
    const res = await post('/v1/admin/auth/logout').set('Cookie', cookiePair(cookie)).expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/brand_admin_rt=;/);
    await get('/v1/admin/me', tokens.accessToken).expect(401);
    await post('/v1/admin/auth/refresh').set('Cookie', cookiePair(cookie)).expect(401);
    expect(await auditActions(admin.id)).toContain('admin.logout');
  });
});

describe('changing the password', () => {
  it('needs the current password and a code, and signs out other sessions', async () => {
    const admin = await createAdmin('support');
    const first = await signIn(admin);
    // A second session (another browser), made directly so this test needs only two codes.
    const other = await app.get(AdminSessionService).create(admin.id, {}, new Date());
    const second = {
      tokens: {
        accessToken: (
          await app
            .get(AdminTokenService)
            .signAccess({ adminId: admin.id, sessionId: other.sessionId })
        ).token,
      },
    };
    const NEW = 'a brand new passphrase';

    const wrong = await request(app.getHttpServer())
      .post('/v1/admin/me/password')
      .set('Authorization', `Bearer ${first.tokens.accessToken}`)
      .send({ currentPassword: 'nope nope nope', newPassword: NEW, code: '000000' })
      .expect(401);
    expect(code(wrong)).toBe('INVALID_CREDENTIALS');

    const short = await request(app.getHttpServer())
      .post('/v1/admin/me/password')
      .set('Authorization', `Bearer ${first.tokens.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: 'short', code: '000000' })
      .expect(400);
    expect(code(short)).toBe('VALIDATION_FAILED');

    await request(app.getHttpServer())
      .post('/v1/admin/me/password')
      .set('Authorization', `Bearer ${first.tokens.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: NEW, code: nextCode(admin) })
      .expect(204);

    await get('/v1/admin/me', first.tokens.accessToken).expect(200);
    await get('/v1/admin/me', second.tokens.accessToken).expect(401);
    await login(admin.email).expect(401);
    await login(admin.email, NEW).expect(200);
    expect(await auditActions(admin.id)).toContain('admin.password_changed');
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    const admin = await createAdmin('owner');
    await signIn(admin);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { adminUserId: admin.id } });
    await expect(
      prisma.$executeRaw`UPDATE audit_log SET action = 'admin.edited' WHERE id = ${row.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${row.id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('an admin change that writes no audit record is refused', async () => {
    const admin = await createAdmin('owner');
    const { tokens } = await signIn(admin);
    await request(app.getHttpServer())
      .post('/v1/admin/test-unaudited')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(500);
  });
});
