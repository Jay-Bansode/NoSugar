import { randomBytes } from 'node:crypto';
import {
  type GatewayOrder,
  type GatewayPayment,
  type GatewayPaymentStatus,
  type GatewayRefund,
  hexEquals,
  type PaymentGateway,
  PaymentGatewayError,
  paymentSignature,
  webhookSignature,
} from './gateway.js';

export const FAKE_KEY_ID = 'rzp_test_fake';
export const FAKE_KEY_SECRET = 'fake_key_secret';
export const FAKE_WEBHOOK_SECRET = 'fake_webhook_secret';

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;

/**
 * In-memory stand-in for Razorpay (development and tests; refused in production). Uses the
 * same signature algorithms as Razorpay, with fixed development secrets.
 */
export class FakeGateway implements PaymentGateway {
  readonly keyId = FAKE_KEY_ID;
  readonly orders = new Map<string, GatewayOrder>();
  readonly payments = new Map<string, GatewayPayment>();
  readonly refunds = new Map<string, GatewayRefund & { paymentId: string; refundRef: string }>();
  /** Test hook: make the next createOrder call fail like an outage. */
  failNextCreateOrder = false;

  async createOrder(input: { amountPaise: number }): Promise<GatewayOrder> {
    if (this.failNextCreateOrder) {
      this.failNextCreateOrder = false;
      throw new PaymentGatewayError('Razorpay unreachable');
    }
    const order = { id: id('order'), amountPaise: input.amountPaise };
    this.orders.set(order.id, order);
    return order;
  }

  /** Test/dev hook: the customer pays on Checkout. Returns what Checkout hands the client. */
  simulatePayment(
    orderId: string,
    options: { status?: GatewayPaymentStatus; amountPaise?: number; method?: string } = {},
  ): { paymentId: string; signature: string } {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown fake order ${orderId}`);
    const payment: GatewayPayment = {
      id: id('pay'),
      orderId,
      amountPaise: options.amountPaise ?? order.amountPaise,
      status: options.status ?? 'captured',
      method: options.method ?? 'upi',
    };
    this.payments.set(payment.id, payment);
    return {
      paymentId: payment.id,
      signature: paymentSignature(FAKE_KEY_SECRET, orderId, payment.id),
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new PaymentGatewayError('Payment not found', 400);
    return { ...payment };
  }

  async capturePayment(paymentId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new PaymentGatewayError('Payment not found', 400);
    payment.status = 'captured';
    return { ...payment };
  }

  async refund(paymentId: string, amountPaise: number, refundRef: string): Promise<GatewayRefund> {
    const existing = [...this.refunds.values()].find((r) => r.refundRef === refundRef);
    if (existing) return existing;
    const refund = {
      id: id('rfnd'),
      amountPaise,
      status: 'pending' as const,
      paymentId,
      refundRef,
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hexEquals(paymentSignature(FAKE_KEY_SECRET, orderId, paymentId), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return hexEquals(webhookSignature(FAKE_WEBHOOK_SECRET, rawBody), signature);
  }
}
