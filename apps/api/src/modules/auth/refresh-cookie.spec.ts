import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.js';
import { readCookie, refreshCookieOptions } from './refresh-cookie.js';

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('a=1; brand_rt=abc-DEF_123; b=2', 'brand_rt')).toBe('abc-DEF_123');
  });

  it('decodes URI-encoded values', () => {
    expect(readCookie('x=hello%20world', 'x')).toBe('hello world');
  });

  it('returns undefined when missing or malformed', () => {
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('a=1', 'x')).toBeUndefined();
    expect(readCookie('x=%E0%A4%A', 'x')).toBeUndefined();
  });

  it('does not match on a name prefix', () => {
    expect(readCookie('brand_rt_old=1', 'brand_rt')).toBeUndefined();
  });
});

describe('refreshCookieOptions', () => {
  it('is httpOnly, SameSite=Lax and scoped to /v1/auth', () => {
    expect(refreshCookieOptions({ NODE_ENV: 'development' } as Env)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/v1/auth',
    });
  });

  it('is Secure in production', () => {
    expect(refreshCookieOptions({ NODE_ENV: 'production' } as Env).secure).toBe(true);
  });
});
