import { Inject, Injectable } from '@nestjs/common';
import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { ENV, type Env } from '../../config/env.js';
import {
  ADMIN_ACCESS_TOKEN_TTL_SECONDS,
  ADMIN_CHALLENGE_TTL_SECONDS,
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
} from './admin.constants.js';

export interface AdminAccessClaims {
  adminId: string;
  sessionId: string;
}

/** Issued after a correct password; exchanged for a session with an authenticator code. */
export interface AdminChallengeClaims {
  adminId: string;
  /** passwordChangedAt (ms): the challenge dies if the password changes meanwhile. */
  passwordVersion: number;
  enrol: boolean;
}

export class InvalidAdminTokenError extends Error {
  constructor() {
    super('Invalid admin token');
    this.name = 'InvalidAdminTokenError';
  }
}

/**
 * Admin JWTs (HS256), signed with keys derived from ADMIN_JWT_SECRET, which no customer token
 * uses: a customer token can never pass as an admin one, and vice versa. Each purpose gets its
 * own derived key (access, sign-in challenge, refresh-token HMAC).
 */
@Injectable()
export class AdminTokenService {
  private readonly accessKey: Uint8Array;
  private readonly challengeKey: Uint8Array;
  private readonly refreshKey: Buffer;

  constructor(@Inject(ENV) env: Env) {
    const derive = (purpose: string) =>
      Buffer.from(hkdfSync('sha256', env.ADMIN_JWT_SECRET, '', `brand-admin:${purpose}`, 32));
    this.accessKey = derive('access-jwt');
    this.challengeKey = derive('challenge-jwt');
    this.refreshKey = derive('refresh-hmac');
  }

  async signAccess(
    claims: AdminAccessClaims,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((iat + ADMIN_ACCESS_TOKEN_TTL_SECONDS) * 1000);
    const token = await new SignJWT({ sid: claims.sessionId, typ: 'admin_access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.adminId)
      .setIssuer(ADMIN_JWT_ISSUER)
      .setAudience(ADMIN_JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(expiresAt)
      .sign(this.accessKey);
    return { token, expiresAt };
  }

  async verifyAccess(token: string, now?: Date): Promise<AdminAccessClaims> {
    const payload = await this.verify(token, this.accessKey, 'admin_access', now);
    if (typeof payload.sid !== 'string') throw new InvalidAdminTokenError();
    return { adminId: payload.sub!, sessionId: payload.sid };
  }

  async signChallenge(
    claims: AdminChallengeClaims,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((iat + ADMIN_CHALLENGE_TTL_SECONDS) * 1000);
    const token = await new SignJWT({
      typ: 'admin_challenge',
      pwv: claims.passwordVersion,
      enr: claims.enrol,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.adminId)
      .setJti(randomUUID())
      .setIssuer(ADMIN_JWT_ISSUER)
      .setAudience(ADMIN_JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(expiresAt)
      .sign(this.challengeKey);
    return { token, expiresAt };
  }

  async verifyChallenge(token: string, now?: Date): Promise<AdminChallengeClaims> {
    const payload = await this.verify(token, this.challengeKey, 'admin_challenge', now);
    if (typeof payload.pwv !== 'number' || typeof payload.enr !== 'boolean') {
      throw new InvalidAdminTokenError();
    }
    return { adminId: payload.sub!, passwordVersion: payload.pwv, enrol: payload.enr };
  }

  /** HMAC of a refresh token; only this is stored. */
  hashRefreshToken(token: string): string {
    return createHmac('sha256', this.refreshKey).update(token).digest('hex');
  }

  private async verify(token: string, key: Uint8Array, typ: string, now?: Date) {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
        algorithms: ['HS256'],
        ...(now ? { currentDate: now } : {}),
      });
      if (payload.typ !== typ || typeof payload.sub !== 'string')
        throw new InvalidAdminTokenError();
      return payload;
    } catch {
      throw new InvalidAdminTokenError();
    }
  }
}
