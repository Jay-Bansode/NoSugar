import type { RateLimitRule } from '../../common/rate-limiter.service.js';

export const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Admin sessions last one working day; refreshing never extends them. */
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Time to enter the authenticator code after the password. */
export const ADMIN_CHALLENGE_TTL_SECONDS = 5 * 60;
export const ADMIN_JWT_ISSUER = 'brand-api';
export const ADMIN_JWT_AUDIENCE = 'brand-admin';
/** Shown in authenticator apps next to the account. PLACEHOLDER until the brand name exists. */
export const TOTP_ISSUER = 'Brand Admin';

/** Failed passwords or codes in a row before the account locks. */
export const ADMIN_MAX_FAILED_ATTEMPTS = 5;
export const ADMIN_LOCK_SECONDS = 15 * 60;

/** Web-only refresh cookie, sent only to the admin auth endpoints. */
export const ADMIN_REFRESH_COOKIE = 'brand_admin_rt';
export const ADMIN_REFRESH_COOKIE_PATH = '/v1/admin/auth';

export const ADMIN_RATE_LIMITS = {
  loginPerIp: { name: 'admin-login:ip', limit: 20, windowSeconds: 10 * 60 },
  loginPerEmail: { name: 'admin-login:email', limit: 10, windowSeconds: 10 * 60 },
  totpPerIp: { name: 'admin-totp:ip', limit: 30, windowSeconds: 10 * 60 },
  refreshPerIp: { name: 'admin-refresh:ip', limit: 120, windowSeconds: 10 * 60 },
} satisfies Record<string, RateLimitRule>;
