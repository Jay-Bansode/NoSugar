import { stateCodeSchema } from '@brand/shared';
import { z } from 'zod';

const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters (use a random value)`);

/**
 * Environment schema (CLAUDE.md §9). Only what the app uses today is required; add each
 * remaining variable here as the module that needs it lands, so startup fails fast and clearly.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_VERSION: z.string().default('0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    /** Number of reverse proxies in front of the API (load balancer = 1). Decides req.ip. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    /** Signs access JWTs (HS256). */
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    /** HMAC key for stored refresh-token hashes. */
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    /** HMAC key for stored OTP hashes. */
    OTP_SECRET: secret('OTP_SECRET'),
    /** Signs admin access and sign-in challenge tokens; HMAC key for admin refresh tokens. */
    ADMIN_JWT_SECRET: secret('ADMIN_JWT_SECRET'),
    /** Encrypts admins' authenticator keys (AES-256-GCM): 32 random bytes, base64. */
    ADMIN_TOTP_KEY: z
      .string()
      .refine(
        (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32,
        'must be 32 random bytes, base64-encoded (openssl rand -base64 32)',
      ),
    /** Only "console" exists until the SMS/WhatsApp provider is chosen (CLAUDE.md §11). */
    OTP_PROVIDER: z.enum(['console']).default('console'),
    /** Public base URL for product media (S3 + CDN). Until the CDN exists, paths stay relative. */
    CDN_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** "stub" answers delivery checks locally (development only); "shiprocket" calls the API. */
    SHIPPING_PROVIDER: z.enum(['stub', 'shiprocket']).default('stub'),
    SHIPROCKET_API_BASE: z
      .url({ protocol: /^https$/ })
      .default('https://apiv2.shiprocket.in/v1/external'),
    /** Dedicated Shiprocket API user, not the main login (CLAUDE.md §9). */
    SHIPROCKET_API_EMAIL: z.email().optional(),
    SHIPROCKET_API_PASSWORD: z.string().min(1).optional(),
    /** Warehouse PIN code: serviceability is checked from here. */
    SHIPROCKET_PICKUP_PINCODE: z
      .string()
      .regex(/^[1-9][0-9]{5}$/)
      .optional(),
    /** "fake" is an in-memory gateway for development (refused in production). */
    PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
    RAZORPAY_API_BASE: z.url({ protocol: /^https$/ }).default('https://api.razorpay.com/v1'),
    RAZORPAY_KEY_ID: z.string().min(1).optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * Seller details printed on GST invoices. Required in production; development and tests
     * use clearly marked placeholders (see invoicing/seller.ts).
     */
    SELLER_GSTIN: z
      .string()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'must be a 15-character GSTIN')
      .optional(),
    /** GST state code of the warehouse/registration, e.g. "27" for Maharashtra. */
    SELLER_STATE_CODE: stateCodeSchema.optional(),
    SELLER_LEGAL_NAME: z.string().trim().min(1).max(200).optional(),
    /** Registered address as one line; printed on invoices. */
    SELLER_ADDRESS: z.string().trim().min(1).max(300).optional(),
    FSSAI_LICENSE_NO: z
      .string()
      .regex(/^[0-9]{14}$/, 'must be the 14-digit FSSAI licence number')
      .optional(),
    /** Background jobs (BullMQ): webhooks, refunds, expiring unpaid orders, invoices. */
    JOBS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.OTP_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_PROVIDER'],
        message: 'the console OTP provider is for development only; configure a real provider',
      });
    }
    if (env.NODE_ENV === 'production' && env.SHIPPING_PROVIDER === 'stub') {
      ctx.addIssue({
        code: 'custom',
        path: ['SHIPPING_PROVIDER'],
        message: 'the stub shipping provider is for development only; use "shiprocket"',
      });
    }
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'the fake payment gateway is for development only; use "razorpay"',
      });
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when PAYMENT_PROVIDER=razorpay',
          });
        }
      }
    }
    if (env.SHIPPING_PROVIDER === 'shiprocket') {
      for (const key of [
        'SHIPROCKET_API_EMAIL',
        'SHIPROCKET_API_PASSWORD',
        'SHIPROCKET_PICKUP_PINCODE',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when SHIPPING_PROVIDER=shiprocket',
          });
        }
      }
    }
    if (env.NODE_ENV === 'production') {
      for (const key of [
        'SELLER_GSTIN',
        'SELLER_STATE_CODE',
        'SELLER_LEGAL_NAME',
        'SELLER_ADDRESS',
        'FSSAI_LICENSE_NO',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required in production (invoices)',
          });
        }
      }
    }
    if (
      env.SELLER_GSTIN &&
      env.SELLER_STATE_CODE &&
      !env.SELLER_GSTIN.startsWith(env.SELLER_STATE_CODE)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SELLER_STATE_CODE'],
        message: 'must match the first two digits of SELLER_GSTIN',
      });
    }
    const secrets = [
      env.JWT_ACCESS_SECRET,
      env.JWT_REFRESH_SECRET,
      env.OTP_SECRET,
      env.ADMIN_JWT_SECRET,
    ];
    if (new Set(secrets).size !== secrets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message:
          'JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, OTP_SECRET and ADMIN_JWT_SECRET must all be different',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Validates the given environment. Error messages name variables but never echo values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
