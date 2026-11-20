import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../../common/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ADMIN_SESSION_TTL_SECONDS } from './admin.constants.js';
import { AdminTokenService } from './admin-token.service.js';

export interface AdminSessionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedAdminSession {
  sessionId: string;
  adminId: string;
  refreshToken: string;
  expiresAt: Date;
}

type Db = Pick<PrismaService, 'adminSession'> | Pick<Prisma.TransactionClient, 'adminSession'>;

/**
 * Admin refresh sessions: rotated on every refresh, with reuse detection (an already-rotated
 * token revokes the whole family). Unlike customer sessions, rotation keeps the original
 * expiry, so a session never outlives one working day.
 */
@Injectable()
export class AdminSessionService {
  private readonly logger = new Logger(AdminSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
  ) {}

  create(
    adminId: string,
    meta: AdminSessionMeta,
    now: Date,
    db: Db = this.prisma,
  ): Promise<IssuedAdminSession> {
    const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000);
    return this.insert(db, adminId, randomUUID(), expiresAt, meta, now);
  }

  async rotate(
    refreshToken: string,
    meta: AdminSessionMeta,
    now = new Date(),
  ): Promise<IssuedAdminSession> {
    const session = await this.prisma.adminSession.findUnique({
      where: { refreshTokenHash: this.tokens.hashRefreshToken(refreshToken) },
      include: { adminUser: { select: { disabledAt: true } } },
    });
    if (!session) throw sessionExpired();
    if (session.revokedAt) {
      if (session.replacedById) {
        await this.revokeFamily(session.familyId, now);
        this.logger.warn(
          `Admin refresh token reuse; family revoked (adminId=${session.adminUserId}, familyId=${session.familyId})`,
        );
      }
      throw sessionExpired();
    }
    if (session.expiresAt <= now || session.adminUser.disabledAt) throw sessionExpired();

    return this.prisma.$transaction(async (tx) => {
      const next = await this.insert(
        tx,
        session.adminUserId,
        session.familyId,
        session.expiresAt,
        meta,
        now,
      );
      const { count } = await tx.adminSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, replacedById: next.sessionId },
      });
      if (count !== 1) throw sessionExpired();
      return next;
    });
  }

  /** Revokes the session for this refresh token; returns its admin, if it was live. */
  async revoke(refreshToken: string, now = new Date()): Promise<string | null> {
    const session = await this.prisma.adminSession.findUnique({
      where: { refreshTokenHash: this.tokens.hashRefreshToken(refreshToken) },
    });
    if (!session || session.revokedAt) return null;
    await this.prisma.adminSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
    });
    return session.adminUserId;
  }

  /** Signs the admin out everywhere (optionally except one session). */
  async revokeAll(
    adminId: string,
    now: Date,
    db: Db = this.prisma,
    exceptSessionId?: string,
  ): Promise<void> {
    await db.adminSession.updateMany({
      where: {
        adminUserId: adminId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: now },
    });
  }

  /** True while the session is neither revoked nor expired (checked on every admin request). */
  async isLive(sessionId: string, adminId: string, now = new Date()): Promise<boolean> {
    const session = await this.prisma.adminSession.findUnique({ where: { id: sessionId } });
    return (
      !!session && session.adminUserId === adminId && !session.revokedAt && session.expiresAt > now
    );
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.adminSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async insert(
    db: Db,
    adminId: string,
    familyId: string,
    expiresAt: Date,
    meta: AdminSessionMeta,
    now: Date,
  ): Promise<IssuedAdminSession> {
    const refreshToken = randomBytes(32).toString('base64url');
    const session = await db.adminSession.create({
      data: {
        adminUserId: adminId,
        familyId,
        refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
        ip: meta.ip ?? null,
        createdAt: now,
      },
    });
    return { sessionId: session.id, adminId, refreshToken, expiresAt };
  }
}

function sessionExpired(): AppException {
  return new AppException(
    ErrorCode.UNAUTHORIZED,
    'Your session has ended. Please sign in again.',
    HttpStatus.UNAUTHORIZED,
  );
}
