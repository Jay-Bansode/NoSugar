import type { CookieOptions } from 'express';
import type { Env } from '../../config/env.js';

/** Web refresh-token cookie (CLAUDE.md §6: httpOnly, Secure, SameSite=Lax). */
export const REFRESH_COOKIE = 'brand_rt';
/** Sent only to auth endpoints, never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/v1/auth';

export function refreshCookieOptions(env: Env, expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    // Browsers treat http://localhost as secure, but test clients and plain-http dev don't.
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    ...(expires ? { expires } : {}),
  };
}

/** Reads one cookie from a Cookie header without pulling in cookie-parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
