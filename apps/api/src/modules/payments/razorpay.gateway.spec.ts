import { describe, expect, it } from 'vitest';
import { PaymentGatewayError, paymentSignature, webhookSignature } from './gateway.js';
import { type FetchFn, RazorpayGateway } from './razorpay.gateway.js';

const config = {
  baseUrl: 'https://rzp.test/v1',
  keyId: 'rzp_test_key',
  keySecret: 'key-secret-123',
  webhookSecret: 'webhook-secret-456',
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status });
  }) as FetchFn;
  return { fn, calls };
}

// Response bodies follow Razorpay's documented shapes (trimmed), not recorded traffic.
const rzpOrder = {
  id: 'order_N1',
  entity: 'order',
  amount: 69900,
  currency: 'INR',
  status: 'created',
};
const rzpPayment = (status: string) => ({
  id: 'pay_P1',
  entity: 'payment',
  amount: 69900,
  currency: 'INR',
  status,
  order_id: 'order_N1',
  method: 'upi',
});

describe('RazorpayGateway', () => {
  it('creates an order in paise with Basic auth and the order number as receipt', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: rzpOrder }));
    const gw = new RazorpayGateway(config, fn);
    const order = await gw.createOrder({
      amountPaise: 69900,
      receipt: 'BR1000001',
      notes: { order_id: 'x' },
    });
    expect(order).toEqual({ id: 'order_N1', amountPaise: 69900 });
    expect(calls[0]).toMatchObject({
      url: 'https://rzp.test/v1/orders',
      method: 'POST',
      body: { amount: 69900, currency: 'INR', receipt: 'BR1000001', notes: { order_id: 'x' } },
    });
    const expectedAuth = `Basic ${Buffer.from('rzp_test_key:key-secret-123').toString('base64')}`;
    expect(calls[0]!.headers.Authorization).toBe(expectedAuth);
  });

  it('fetches and captures payments', async () => {
    const { fn, calls } = fakeFetch((call) =>
      call.url.endsWith('/capture')
        ? { status: 200, body: rzpPayment('captured') }
        : { status: 200, body: rzpPayment('authorized') },
    );
    const gw = new RazorpayGateway(config, fn);
    expect(await gw.fetchPayment('pay_P1')).toEqual({
      id: 'pay_P1',
      orderId: 'order_N1',
      amountPaise: 69900,
      status: 'authorized',
      method: 'upi',
    });
    expect((await gw.capturePayment('pay_P1', 69900)).status).toBe('captured');
    expect(calls[1]).toMatchObject({
      url: 'https://rzp.test/v1/payments/pay_P1/capture',
      body: { amount: 69900, currency: 'INR' },
    });
  });

  it('refunds once per reference: an existing tagged refund is returned, not repeated', async () => {
    const existing = {
      entity: 'collection',
      count: 1,
      items: [{ id: 'rfnd_1', amount: 69900, status: 'processed', notes: { refund_ref: 'ref-A' } }],
    };
    const { fn, calls } = fakeFetch((call) =>
      call.method === 'GET'
        ? { status: 200, body: existing }
        : {
            status: 200,
            body: { id: 'rfnd_2', amount: 500, status: 'pending', notes: { refund_ref: 'ref-B' } },
          },
    );
    const gw = new RazorpayGateway(config, fn);

    expect(await gw.refund('pay_P1', 69900, 'ref-A')).toEqual({
      id: 'rfnd_1',
      amountPaise: 69900,
      status: 'processed',
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    expect((await gw.refund('pay_P1', 500, 'ref-B')).id).toBe('rfnd_2');
    expect(calls.at(-1)).toMatchObject({
      url: 'https://rzp.test/v1/payments/pay_P1/refund',
      method: 'POST',
      body: { amount: 500, notes: { refund_ref: 'ref-B' } },
    });
  });

  it("surfaces Razorpay's error description, never the secret", async () => {
    const { fn } = fakeFetch(() => ({
      status: 400,
      body: {
        error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least INR 1.00' },
      },
    }));
    const err = (await new RazorpayGateway(config, fn)
      .createOrder({ amountPaise: 50, receipt: 'r', notes: {} })
      .then(
        () => expect.unreachable('expected an error'),
        (e: unknown) => e,
      )) as PaymentGatewayError;
    expect(err).toBeInstanceOf(PaymentGatewayError);
    expect(err.message).toBe(
      'Razorpay POST orders failed (400): The amount must be at least INR 1.00',
    );
    expect(err.message).not.toContain(config.keySecret);
  });

  it('turns network failures into PaymentGatewayError', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as FetchFn;
    await expect(new RazorpayGateway(config, fn).fetchPayment('pay_1')).rejects.toThrow(
      'Razorpay unreachable',
    );
  });

  it('verifies signatures with its own secrets', () => {
    const gw = new RazorpayGateway(config, (async () => new Response('{}')) as FetchFn);
    const sig = paymentSignature(config.keySecret, 'order_N1', 'pay_P1');
    expect(gw.verifyPaymentSignature('order_N1', 'pay_P1', sig)).toBe(true);
    expect(gw.verifyPaymentSignature('order_N1', 'pay_P2', sig)).toBe(false);
    const body = Buffer.from('{"event":"payment.captured"}');
    expect(gw.verifyWebhookSignature(body, webhookSignature(config.webhookSecret, body))).toBe(
      true,
    );
    expect(gw.verifyWebhookSignature(body, webhookSignature(config.keySecret, body))).toBe(false);
  });
});
