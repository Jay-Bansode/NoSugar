import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { ENV, type Env } from '../../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('Invalid access token');
    this.name = 'InvalidAccessTokenError';
  }
}

/** Short-lived access JWTs (HS256). Stateless: valid until expiry even after logout. */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  async signAccessToken(
    auth: AuthContext,
    now: Date = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((issuedAt + ACCESS_TOKEN_TTL_SECONDS) * 1000);
    const token = await new SignJWT({ sid: auth.sessionId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(auth.userId)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string, now?: Date): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
        ...(now ? { currentDate: now } : {}),
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string') {
        throw new InvalidAccessTokenError();
      }
      if (typeof payload.sid !== 'string') throw new InvalidAccessTokenError();
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new InvalidAccessTokenError();
    }
  }
}
