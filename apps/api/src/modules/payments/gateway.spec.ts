import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FAKE_KEY_SECRET, FAKE_WEBHOOK_SECRET, FakeGateway } from './fake.gateway.js';
import { hexEquals, paymentSignature, webhookSignature } from './gateway.js';

describe('Razorpay signatures', () => {
  it('payment signature = HMAC-SHA256("order_id|payment_id", key secret)', () => {
    const expected = createHmac('sha256', 'secret').update('order_ABC|pay_XYZ').digest('hex');
    expect(paymentSignature('secret', 'order_ABC', 'pay_XYZ')).toBe(expected);
  });

  it('webhook signature = HMAC-SHA256(raw body, webhook secret)', () => {
    const body = '{"event":"payment.captured"}';
    const expected = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(webhookSignature('whsec', Buffer.from(body))).toBe(expected);
  });

  it('compares hex digests safely', () => {
    const sig = paymentSignature('s', 'order_A', 'pay_B');
    expect(hexEquals(sig, sig)).toBe(true);
    expect(hexEquals(sig, sig.toUpperCase())).toBe(true); // hex is case-insensitive
    expect(hexEquals(sig, sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(hexEquals(sig, sig.slice(0, 10))).toBe(false);
    expect(hexEquals(sig, 'z'.repeat(64))).toBe(false);
    expect(hexEquals(sig, '')).toBe(false);
  });
});

describe('FakeGateway', () => {
  it('signs like Razorpay with its development secrets', async () => {
    const fake = new FakeGateway();
    const order = await fake.createOrder({ amountPaise: 69900 });
    const { paymentId, signature } = fake.simulatePayment(order.id);
    expect(signature).toBe(paymentSignature(FAKE_KEY_SECRET, order.id, paymentId));
    expect(fake.verifyPaymentSignature(order.id, paymentId, signature)).toBe(true);
    expect(fake.verifyPaymentSignature(order.id, 'pay_other', signature)).toBe(false);

    const body = Buffer.from('{}');
    expect(fake.verifyWebhookSignature(body, webhookSignature(FAKE_WEBHOOK_SECRET, body))).toBe(
      true,
    );
    expect(fake.verifyWebhookSignature(body, webhookSignature('wrong', body))).toBe(false);
  });

  it('never refunds the same reference twice', async () => {
    const fake = new FakeGateway();
    const a = await fake.refund('pay_1', 100, 'ref-1');
    const b = await fake.refund('pay_1', 100, 'ref-1');
    expect(b.id).toBe(a.id);
    expect(fake.refunds.size).toBe(1);
  });
});
