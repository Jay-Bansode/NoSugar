import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AdminChangePassword,
  type AdminLoginChallenge,
  type AdminMe,
  ErrorCode,
} from '@brand/shared';
import { createHash } from 'node:crypto';
import { AuditService } from '../../audit/audit.service.js';
import { AppException } from '../../common/app.exception.js';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ENV, type Env } from '../../config/env.js';
import type { AdminUser } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ADMIN_LOCK_SECONDS,
  ADMIN_MAX_FAILED_ATTEMPTS,
  ADMIN_RATE_LIMITS,
  TOTP_ISSUER,
} from './admin.constants.js';
import type { AdminContext } from './admin.guard.js';
import { type AdminSessionMeta, AdminSessionService } from './admin-session.service.js';
import { AdminTokenService, type AdminChallengeClaims } from './admin-token.service.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';
import { SecretBox } from './secret-box.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

export interface AdminSignedIn {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  sessionExpiresAt: Date;
  admin: AdminMe;
}

export type AdminRefreshed = Omit<AdminSignedIn, 'refreshToken'> & { refreshToken: string };

const toMe = (a: Pick<AdminUser, 'id' | 'email' | 'name' | 'role'>): AdminMe => ({
  id: a.id,
  email: a.email,
  name: a.name,
  role: a.role,
});

/**
 * Admin sign-in: email + password, then a code from an authenticator app (CLAUDE.md §8
 * two-factor auth). The first sign-in sets the app up. Five failures in a row (password or
 * code) lock the account for 15 minutes; a locked account only says so to someone who knows
 * the password. Wrong email and wrong password give the same answer.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
    private readonly sessions: AdminSessionService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(ENV) env: Env,
  ) {
    this.box = new SecretBox(env.ADMIN_TOTP_KEY);
  }

  async login(
    email: string,
    password: string,
    meta: AdminSessionMeta,
    now = new Date(),
  ): Promise<AdminLoginChallenge> {
    await this.rateLimiter.consume(ADMIN_RATE_LIMITS.loginPerIp, meta.ip ?? 'unknown');
    await this.rateLimiter.consume(ADMIN_RATE_LIMITS.loginPerEmail, emailKey(email));

    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    // Always run the hash, so an unknown email takes as long as a wrong password.
    const ok = await verifyPassword(password, admin?.passwordHash ?? (await dummyPasswordHash()));
    if (!admin || admin.disabledAt) throw invalidCredentials();
    if (isLocked(admin, now)) {
      if (ok) throw locked(admin, now);
      throw invalidCredentials();
    }
    if (!ok) {
      await this.registerFailure(admin.id, 'admin.login_failed', meta, now);
      throw invalidCredentials();
    }

    const enrol = admin.totpEnabledAt === null;
    let enrolment: AdminLoginChallenge['enrolment'] = null;
    if (enrol) {
      // A fresh key on every attempt until the admin proves the app works.
      const secret = generateTotpSecret();
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { totpSecret: this.box.seal(secret, admin.id), totpLastStep: null },
      });
      enrolment = { secret, otpauthUrl: otpauthUrl(secret, admin.email, TOTP_ISSUER) };
    }
    const challenge = await this.tokens.signChallenge(
      { adminId: admin.id, passwordVersion: admin.passwordChangedAt.getTime(), enrol },
      now,
    );
    return {
      next: enrol ? 'enrol' : 'verify',
      challengeToken: challenge.token,
      challengeExpiresAt: challenge.expiresAt.toISOString(),
      enrolment,
    };
  }

  async completeTotp(
    challengeToken: string,
    code: string,
    meta: AdminSessionMeta,
    now = new Date(),
  ): Promise<AdminSignedIn> {
    await this.rateLimiter.consume(ADMIN_RATE_LIMITS.totpPerIp, meta.ip ?? 'unknown');
    let claims: AdminChallengeClaims;
    try {
      claims = await this.tokens.verifyChallenge(challengeToken, now);
    } catch {
      throw challengeExpired();
    }
    const admin = await this.prisma.adminUser.findUnique({ where: { id: claims.adminId } });
    if (
      !admin ||
      admin.disabledAt ||
      admin.passwordChangedAt.getTime() !== claims.passwordVersion ||
      claims.enrol !== (admin.totpEnabledAt === null) ||
      !admin.totpSecret
    ) {
      throw challengeExpired();
    }
    if (isLocked(admin, now)) throw locked(admin, now);

    const step = verifyTotp(
      this.box.open(admin.totpSecret, admin.id),
      code,
      now,
      admin.totpLastStep,
    );
    if (step === null) {
      await this.registerFailure(admin.id, 'admin.totp_failed', meta, now);
      throw totpInvalid();
    }

    const actor = { adminId: admin.id, ip: meta.ip ?? null };
    return this.prisma.$transaction(async (tx) => {
      // Conditional on the step, so two requests racing with the same code can't both win.
      const { count } = await tx.adminUser.updateMany({
        where: { id: admin.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: {
          totpLastStep: step,
          totpEnabledAt: admin.totpEnabledAt ?? now,
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: now,
        },
      });
      if (count !== 1) throw totpInvalid();
      const session = await this.sessions.create(admin.id, meta, now, tx);
      if (claims.enrol) {
        await this.audit.record(
          actor,
          { action: 'admin.totp_enrolled', entityType: 'admin_user', entityId: admin.id },
          tx,
        );
      }
      await this.audit.record(
        actor,
        {
          action: 'admin.login',
          entityType: 'admin_user',
          entityId: admin.id,
          changes: { sessionId: session.sessionId },
        },
        tx,
      );
      const access = await this.tokens.signAccess(
        { adminId: admin.id, sessionId: session.sessionId },
        now,
      );
      this.logger.log(`Admin signed in (adminId=${admin.id})`);
      return {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: session.refreshToken,
        sessionExpiresAt: session.expiresAt,
        admin: toMe(admin),
      };
    });
  }

  async refresh(
    refreshToken: string,
    meta: AdminSessionMeta,
    now = new Date(),
  ): Promise<AdminRefreshed> {
    await this.rateLimiter.consume(ADMIN_RATE_LIMITS.refreshPerIp, meta.ip ?? 'unknown');
    const session = await this.sessions.rotate(refreshToken, meta, now);
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: session.adminId } });
    const access = await this.tokens.signAccess(
      { adminId: admin.id, sessionId: session.sessionId },
      now,
    );
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: session.refreshToken,
      sessionExpiresAt: session.expiresAt,
      admin: toMe(admin),
    };
  }

  async logout(refreshToken: string, meta: AdminSessionMeta, now = new Date()): Promise<void> {
    const adminId = await this.sessions.revoke(refreshToken, now);
    if (adminId) {
      await this.audit.record(
        { adminId, ip: meta.ip ?? null },
        { action: 'admin.logout', entityType: 'admin_user', entityId: adminId },
      );
    }
  }

  async me(adminId: string): Promise<AdminMe> {
    return toMe(await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } }));
  }

  /** Needs the current password and a fresh code. Signs out every other session. */
  async changePassword(
    ctx: AdminContext,
    input: AdminChangePassword,
    now = new Date(),
  ): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: ctx.adminId } });
    const meta = { ip: ctx.ip ?? undefined };
    if (!(await verifyPassword(input.currentPassword, admin.passwordHash))) {
      await this.registerFailure(admin.id, 'admin.password_change_failed', meta, now);
      throw invalidCredentials('The current password is wrong.');
    }
    const step = admin.totpSecret
      ? verifyTotp(this.box.open(admin.totpSecret, admin.id), input.code, now, admin.totpLastStep)
      : null;
    if (step === null) {
      await this.registerFailure(admin.id, 'admin.password_change_failed', meta, now);
      throw totpInvalid();
    }
    const passwordHash = await hashPassword(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.adminUser.updateMany({
        where: { id: admin.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { passwordHash, passwordChangedAt: now, totpLastStep: step, failedAttempts: 0 },
      });
      if (count !== 1) throw totpInvalid();
      await this.sessions.revokeAll(admin.id, now, tx, ctx.sessionId);
      await this.audit.record(
        ctx,
        { action: 'admin.password_changed', entityType: 'admin_user', entityId: admin.id },
        tx,
      );
    });
  }

  /** Counts a failure atomically; the fifth in a row locks the account. */
  private async registerFailure(
    adminId: string,
    action: string,
    meta: AdminSessionMeta,
    now: Date,
  ): Promise<void> {
    const lockUntil = new Date(now.getTime() + ADMIN_LOCK_SECONDS * 1000);
    const [row] = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      UPDATE admin_users SET
        failed_attempts = CASE WHEN failed_attempts + 1 >= ${ADMIN_MAX_FAILED_ATTEMPTS} THEN 0 ELSE failed_attempts + 1 END,
        locked_until = CASE WHEN failed_attempts + 1 >= ${ADMIN_MAX_FAILED_ATTEMPTS} THEN ${lockUntil} ELSE locked_until END,
        updated_at = ${now}
      WHERE id = ${adminId}::uuid
      RETURNING (locked_until IS NOT NULL AND locked_until > ${now}) AS locked`;
    await this.audit.record(
      { adminId, ip: meta.ip ?? null },
      {
        action,
        entityType: 'admin_user',
        entityId: adminId,
        changes: { locked: row?.locked ?? false },
      },
    );
    if (row?.locked)
      this.logger.warn(`Admin account locked after repeated failures (adminId=${adminId})`);
  }
}

/** Rate-limit key for an email: hashed, so raw addresses never sit in Redis. */
function emailKey(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 32);
}

function isLocked(admin: Pick<AdminUser, 'lockedUntil'>, now: Date): boolean {
  return !!admin.lockedUntil && admin.lockedUntil > now;
}

function invalidCredentials(message = 'Wrong email or password.'): AppException {
  return new AppException(ErrorCode.INVALID_CREDENTIALS, message, HttpStatus.UNAUTHORIZED);
}

function locked(admin: Pick<AdminUser, 'lockedUntil'>, now: Date): AppException {
  const retryAfterSeconds = Math.ceil((admin.lockedUntil!.getTime() - now.getTime()) / 1000);
  return new AppException(
    ErrorCode.ACCOUNT_LOCKED,
    'Too many failed attempts. Try again later.',
    HttpStatus.LOCKED,
    { retryAfterSeconds },
  );
}

function totpInvalid(): AppException {
  return new AppException(
    ErrorCode.TOTP_INVALID,
    'That code didn’t work. Enter the current code from your authenticator app.',
    HttpStatus.UNAUTHORIZED,
  );
}

function challengeExpired(): AppException {
  return new AppException(
    ErrorCode.UNAUTHORIZED,
    'Your sign-in has expired. Please start again.',
    HttpStatus.UNAUTHORIZED,
  );
}
