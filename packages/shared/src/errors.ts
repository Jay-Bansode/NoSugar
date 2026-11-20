import { z } from 'zod';

/** API error codes (CLAUDE.md §7). Add new codes here, UPPER_SNAKE_CASE. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_TOO_MANY_ATTEMPTS: 'OTP_TOO_MANY_ATTEMPTS',
  /** Unknown, inactive, not yet started or expired code. */
  DISCOUNT_INVALID: 'DISCOUNT_INVALID',
  /** Valid code that can't be used here: usage limit reached or already used by this customer. */
  DISCOUNT_NOT_APPLICABLE: 'DISCOUNT_NOT_APPLICABLE',
  /** Cart item no longer sellable (inactive) or malformed (bad bundle selection). */
  ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
  COD_UNAVAILABLE: 'COD_UNAVAILABLE',
  /** Guest cart id unknown, expired or not usable by this client: drop it and start over. */
  CART_NOT_FOUND: 'CART_NOT_FOUND',
  CART_FULL: 'CART_FULL',
  /** One-per-customer item (the trial kit) already in the cart or already bought. */
  PURCHASE_LIMIT: 'PURCHASE_LIMIT',
  CART_EMPTY: 'CART_EMPTY',
  /** Some cart lines can't be bought (see the cart's line issues). */
  CART_HAS_ISSUES: 'CART_HAS_ISSUES',
  /** We can't deliver to this PIN code. */
  NOT_SERVICEABLE: 'NOT_SERVICEABLE',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  /** Bad signature, or Razorpay's record doesn't match the order (amount, order id, status). */
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  /** The order has no invoice (yet): it is issued shortly after confirmation. */
  INVOICE_NOT_AVAILABLE: 'INVOICE_NOT_AVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorCodeSchema = z.enum(ErrorCode);

/** Shape of every error response body: `{ error: { code, message, details } }`. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
