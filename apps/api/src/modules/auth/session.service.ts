import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../../common/app.exception.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REFRESH_TOKEN_TTL_SECONDS } from './auth.constants.js';

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface IssuedSession {
  sessionId: string;
  userId: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Refresh-token sessions with rotation. Each refresh replaces the session with a new one in
 * the same family. Presenting an already-rotated token means it was stolen or replayed, so
 * the whole family is revoked and the user must log in again.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  async create(userId: string, meta: SessionMeta, now = new Date()): Promise<IssuedSession> {
    return this.insert(userId, randomUUID(), meta, now);
  }

  async rotate(refreshToken: string, meta: SessionMeta, now = new Date()): Promise<IssuedSession> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.hash(refreshToken) },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!session) throw unauthorized();

    if (session.revokedAt) {
      if (session.replacedById) {
        await this.revokeFamily(session.familyId, now);
        this.logger.warn(
          `Refresh token reuse detected; family revoked (userId=${session.userId}, familyId=${session.familyId})`,
        );
      }
      throw unauthorized();
    }
    if (session.expiresAt <= now || session.user.deletedAt) throw unauthorized();

    return this.prisma.$transaction(async (tx) => {
      const next = await this.insert(session.userId, session.familyId, meta, now, tx);
      // Conditional update: if a concurrent refresh already rotated it, abort this one.
      const { count } = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, replacedById: next.sessionId },
      });
      if (count !== 1) throw unauthorized();
      return next;
    });
  }

  /** Idempotent logout. Unknown or already-revoked tokens are ignored. */
  async revoke(refreshToken: string, now = new Date()): Promise<void> {
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: this.hash(refreshToken), revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async insert(
    userId: string,
    familyId: string,
    meta: SessionMeta,
    now: Date,
    db: Pick<PrismaService, 'session'> = this.prisma,
  ): Promise<IssuedSession> {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    const session = await db.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: this.hash(refreshToken),
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
        ip: meta.ip ?? null,
        createdAt: now,
      },
    });
    return { sessionId: session.id, userId, refreshToken, expiresAt };
  }

  private hash(refreshToken: string): string {
    return createHmac('sha256', this.env.JWT_REFRESH_SECRET).update(refreshToken).digest('hex');
  }
}

function unauthorized(): AppException {
  return new AppException(
    ErrorCode.UNAUTHORIZED,
    'Session expired. Please log in again.',
    HttpStatus.UNAUTHORIZED,
  );
}
