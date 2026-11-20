import { z } from 'zod';

/**
 * Admin panel auth (CLAUDE.md §8 Security: two-factor auth, role-based access).
 * Sign-in is email + password, then a 6-digit code from an authenticator app (TOTP).
 */
export const ADMIN_ROLES = ['owner', 'operations', 'support'] as const;
export const adminRoleSchema = z.enum(ADMIN_ROLES);
export type AdminRole = z.infer<typeof adminRoleSchema>;

export const ADMIN_PASSWORD_MIN = 12;
export const ADMIN_PASSWORD_MAX = 128;
export const TOTP_DIGITS = 6;

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(254));

export const adminPasswordSchema = z
  .string()
  .min(ADMIN_PASSWORD_MIN, `Use at least ${ADMIN_PASSWORD_MIN} characters`)
  .max(ADMIN_PASSWORD_MAX, `Use at most ${ADMIN_PASSWORD_MAX} characters`);

const totpCode = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`), `Enter the ${TOTP_DIGITS}-digit code from your app`);

export const adminLoginSchema = z.object({
  email,
  // Not the full policy: an old password that predates it must still be able to log in.
  password: z.string().min(1).max(ADMIN_PASSWORD_MAX),
});
export type AdminLogin = z.infer<typeof adminLoginSchema>;

/** Step 2 of sign-in. `challengeToken` comes from the login response. */
export const adminTotpSchema = z.object({
  challengeToken: z.string().min(20).max(1000),
  code: totpCode,
});
export type AdminTotp = z.infer<typeof adminTotpSchema>;

export const adminLoginChallengeSchema = z.object({
  /** "verify": enter a code from the app. "enrol": add the key to the app first, then enter a code. */
  next: z.enum(['verify', 'enrol']),
  challengeToken: z.string(),
  challengeExpiresAt: z.string(),
  /** Only for "enrol": the key to add to the authenticator app (also as an otpauth:// URL for a QR code). */
  enrolment: z.object({ secret: z.string(), otpauthUrl: z.string() }).nullable(),
});
export type AdminLoginChallenge = z.infer<typeof adminLoginChallengeSchema>;

export const adminMeSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: adminRoleSchema,
});
export type AdminMe = z.infer<typeof adminMeSchema>;

/** The refresh token travels only in an httpOnly cookie (the admin panel is web-only). */
export const adminTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  sessionExpiresAt: z.string(),
  admin: adminMeSchema,
});
export type AdminTokens = z.infer<typeof adminTokensSchema>;

export const adminChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(ADMIN_PASSWORD_MAX),
    newPassword: adminPasswordSchema,
    code: totpCode,
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from the current one',
  });
export type AdminChangePassword = z.infer<typeof adminChangePasswordSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  admin: z.object({ id: z.string(), email: z.string(), name: z.string() }).nullable(),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  changes: z.unknown(),
  ip: z.string().nullable(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
