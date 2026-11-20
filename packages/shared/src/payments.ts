import { z } from 'zod';

/** What the client posts after Razorpay Checkout succeeds (CLAUDE.md §6 step 5). */
export const verifyPaymentSchema = z.strictObject({
  razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]+$/, 'Invalid Razorpay order id'),
  razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/, 'Invalid Razorpay payment id'),
  razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid signature'),
});
export type VerifyPayment = z.infer<typeof verifyPaymentSchema>;

/** Everything a client needs to open Razorpay Checkout for an unpaid order. */
export const paymentDetailsSchema = z.object({
  provider: z.literal('razorpay'),
  /** Public key id (safe to expose; the secret never leaves the API). */
  keyId: z.string(),
  razorpayOrderId: z.string(),
  amountPaise: z.number().int(),
  currency: z.literal('INR'),
});
export type PaymentDetails = z.infer<typeof paymentDetailsSchema>;

export const REFUND_STATUSES = ['pending', 'processed', 'failed'] as const;
export const refundSummarySchema = z.object({
  status: z.enum(REFUND_STATUSES),
  amountPaise: z.number().int(),
});
export type RefundSummary = z.infer<typeof refundSummarySchema>;
