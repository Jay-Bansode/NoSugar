import { z } from 'zod';
import {
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  hexEquals,
  type PaymentGateway,
  PaymentGatewayError,
  paymentSignature,
  webhookSignature,
} from './gateway.js';

export type FetchFn = typeof fetch;

export interface RazorpayConfig {
  baseUrl: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  timeoutMs?: number;
}

const paymentSchema = z.looseObject({
  id: z.string(),
  order_id: z.string().nullish(),
  amount: z.number().int(),
  status: z.enum(['created', 'authorized', 'captured', 'refunded', 'failed']),
  method: z.string().nullish(),
});

const refundSchema = z.looseObject({
  id: z.string(),
  amount: z.number().int(),
  status: z.enum(['pending', 'processed', 'failed']),
  notes: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullish(),
});

const toPayment = (p: z.infer<typeof paymentSchema>): GatewayPayment => ({
  id: p.id,
  orderId: p.order_id ?? null,
  amountPaise: p.amount,
  status: p.status,
  method: p.method ?? null,
});

const toRefund = (r: z.infer<typeof refundSchema>): GatewayRefund => ({
  id: r.id,
  amountPaise: r.amount,
  status: r.status,
});

/**
 * Razorpay REST API (https://api.razorpay.com/v1) over plain fetch, Basic auth with the key
 * id and secret. Never logs or returns the secret.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly keyId: string;

  constructor(
    private readonly config: RazorpayConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.keyId = config.keyId;
  }

  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder> {
    const body = await this.request('POST', '/orders', {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    const order = z.looseObject({ id: z.string(), amount: z.number().int() }).parse(body);
    return { id: order.id, amountPaise: order.amount };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    return toPayment(paymentSchema.parse(await this.request('GET', `/payments/${enc(paymentId)}`)));
  }

  async capturePayment(paymentId: string, amountPaise: number): Promise<GatewayPayment> {
    const body = await this.request('POST', `/payments/${enc(paymentId)}/capture`, {
      amount: amountPaise,
      currency: 'INR',
    });
    return toPayment(paymentSchema.parse(body));
  }

  async refund(paymentId: string, amountPaise: number, refundRef: string): Promise<GatewayRefund> {
    // Razorpay has no idempotency key for refunds: tag ours and look for it before creating.
    const existing = z
      .looseObject({ items: z.array(refundSchema) })
      .parse(await this.request('GET', `/payments/${enc(paymentId)}/refunds`));
    const match = existing.items.find(
      (r) => r.notes && !Array.isArray(r.notes) && r.notes.refund_ref === refundRef,
    );
    if (match) return toRefund(match);

    const created = await this.request('POST', `/payments/${enc(paymentId)}/refund`, {
      amount: amountPaise,
      notes: { refund_ref: refundRef },
    });
    return toRefund(refundSchema.parse(created));
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hexEquals(paymentSignature(this.config.keySecret, orderId, paymentId), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return hexEquals(webhookSignature(this.config.webhookSecret, rawBody), signature);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new PaymentGatewayError(`Razorpay ${reason}`);
    }
    const json = parseJson(await res.text());
    if (!res.ok) {
      const description = z
        .object({ error: z.object({ description: z.string().optional() }) })
        .safeParse(json);
      throw new PaymentGatewayError(
        `Razorpay ${method} ${path.split('/')[1]} failed (${res.status})${
          description.success && description.data.error.description
            ? `: ${description.data.error.description}`
            : ''
        }`,
        res.status,
      );
    }
    return json;
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
