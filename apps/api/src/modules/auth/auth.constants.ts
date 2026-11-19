import type { RateLimitRule } from '../../common/rate-limiter.service.js';

/** OTP lifetime. */
export const OTP_TTL_SECONDS = 5 * 60;
/** Minimum gap between two OTP sends to the same phone. */
export const OTP_RESEND_SECONDS = 30;
/** Wrong guesses allowed per OTP before it is burned. */
export const OTP_MAX_ATTEMPTS = 5;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const JWT_ISSUER = 'brand-api';
export const JWT_AUDIENCE = 'brand';

/** Rate limits (CLAUDE.md §8). Security limits, so constants rather than admin settings. */
export const RATE_LIMITS = {
  otpPerPhone: { name: 'otp:phone', limit: 5, windowSeconds: 60 * 60 },
  otpPerIp: { name: 'otp:ip', limit: 20, windowSeconds: 60 * 60 },
  verifyPerIp: { name: 'verify:ip', limit: 30, windowSeconds: 10 * 60 },
  refreshPerIp: { name: 'refresh:ip', limit: 60, windowSeconds: 10 * 60 },
} satisfies Record<string, RateLimitRule>;
