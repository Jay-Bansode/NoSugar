import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payment gateway boundary. Razorpay in production; an in-memory fake in development and
 * tests. Amounts are integer paise.
 */

export type GatewayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
export type GatewayRefundStatus = 'pending' | 'processed' | 'failed';

export interface GatewayOrder {
  id: string;
  amountPaise: number;
}

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  amountPaise: number;
  status: GatewayPaymentStatus;
  method: string | null;
}

export interface GatewayRefund {
  id: string;
  amountPaise: number;
  status: GatewayRefundStatus;
}

export interface PaymentGateway {
  /** Public key id for Checkout; safe to send to clients. */
  readonly keyId: string;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  capturePayment(paymentId: string, amountPaise: number): Promise<GatewayPayment>;
  /** Idempotent per `refundRef`: retrying never refunds twice. */
  refund(paymentId: string, amountPaise: number, refundRef: string): Promise<GatewayRefund>;
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

/** Razorpay Checkout signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret), hex. */
export function paymentSignature(keySecret: string, orderId: string, paymentId: string): string {
  return createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
}

/** Razorpay webhook signature: HMAC-SHA256(raw request body, webhook_secret), hex. */
export function webhookSignature(webhookSecret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hexEquals(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]+$/i.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
