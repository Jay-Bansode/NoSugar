import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { TEST_ENV } from '../../../test/helpers/env.js';
import type { Env } from '../../config/env.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import { InvalidAccessTokenError, TokenService } from './token.service.js';

const env = { JWT_ACCESS_SECRET: TEST_ENV.JWT_ACCESS_SECRET } as Env;
const service = new TokenService(env);
const auth = { userId: 'user-1', sessionId: 'session-1' };

describe('TokenService', () => {
  it('round-trips user and session ids', async () => {
    const { token } = await service.signAccessToken(auth);
    await expect(service.verifyAccessToken(token)).resolves.toEqual(auth);
  });

  it('expires after the access TTL', async () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const { token, expiresAt } = await service.signAccessToken(auth, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(ACCESS_TOKEN_TTL_SECONDS * 1000);

    const justBefore = new Date(expiresAt.getTime() - 1000);
    await expect(service.verifyAccessToken(token, justBefore)).resolves.toEqual(auth);
    const after = new Date(expiresAt.getTime() + 1000);
    await expect(service.verifyAccessToken(token, after)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects tokens signed with another secret', async () => {
    const other = new TokenService({
      JWT_ACCESS_SECRET: 'another-secret-0123456789abcdefghijk',
    } as Env);
    const { token } = await other.signAccessToken(auth);
    await expect(service.verifyAccessToken(token)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects unsigned (alg: none) tokens', async () => {
    const token = new UnsecuredJWT({ sid: 's', typ: 'access' })
      .setSubject('u')
      .setIssuer('brand-api')
      .setAudience('brand')
      .encode();
    await expect(service.verifyAccessToken(token)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects correctly signed tokens of another type', async () => {
    const token = await new SignJWT({ sid: 's', typ: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('brand-api')
      .setAudience('brand')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(TEST_ENV.JWT_ACCESS_SECRET));
    await expect(service.verifyAccessToken(token)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects garbage', async () => {
    await expect(service.verifyAccessToken('a.b.c')).rejects.toThrow(InvalidAccessTokenError);
  });
});
