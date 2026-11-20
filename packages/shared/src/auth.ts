import { z } from 'zod';
import { phoneSchema } from './phone.js';

/**
 * Auth request/response schemas (CLAUDE.md §6 Login).
 * `client: 'web'` → refresh token is set as an httpOnly cookie and omitted from the body.
 * `client: 'app'` → refresh token is returned in the body for expo-secure-store.
 */
export const authClientSchema = z.enum(['web', 'app']);
export type AuthClient = z.infer<typeof authClientSchema>;

export const OTP_LENGTH = 6;

export const requestOtpSchema = z.object({
  phone: phoneSchema,
  channel: z.enum(['sms', 'whatsapp']).default('sms'),
});
export type RequestOtp = z.infer<typeof requestOtpSchema>;

export const otpRequestedSchema = z.object({
  expiresInSeconds: z.number().int(),
  resendAfterSeconds: z.number().int(),
});
export type OtpRequested = z.infer<typeof otpRequestedSchema>;

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`),
  client: authClientSchema,
});
export type VerifyOtp = z.infer<typeof verifyOtpSchema>;

/** Body for refresh and logout. Web sends no token (the cookie carries it). */
export const refreshTokenBodySchema = z.object({
  client: authClientSchema,
  refreshToken: z.string().min(20).max(200).optional(),
});
export type RefreshTokenBody = z.infer<typeof refreshTokenBodySchema>;

export const meSchema = z.object({
  id: z.string(),
  phone: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  marketingConsent: z.boolean(),
  createdAt: z.string(),
});
export type Me = z.infer<typeof meSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  /** Present only for `client: 'app'`. */
  refreshToken: z.string().optional(),
  refreshTokenExpiresAt: z.string(),
  user: meSchema,
});
export type AuthTokens = z.infer<typeof authTokensSchema>;
