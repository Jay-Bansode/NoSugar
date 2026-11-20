/**
 * Payments, webhooks and refunds over HTTP against real Postgres + Redis + BullMQ, with the
 * fake gateway (same signature algorithms as Razorpay). Covers CLAUDE.md §10:
 * "payment captured but client never returned" and "duplicate webhook delivery".
 * Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { errorResponseSchema, type OrderDetail, orderDetailSchema } from '@brand/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import {
  FAKE_KEY_ID,
  FAKE_WEBHOOK_SECRET,
  FakeGateway,
} from '../src/modules/payments/fake.gateway.js';
import { PAYMENT_GATEWAY, webhookSignature } from '../src/modules/payments/gateway.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';

const run = randomUUID().slice(0, 8).toUpperCase();
let app: NestExpressApplication;
let prisma: PrismaService;
let gateway: FakeGateway;

const f = {
  productIds: [] as string[],
  userIds: [] as string[],
  eventIds: [] as string[],
  fifteen: '',
};
const ADDRESS = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Pune',
  stateCode: '27',
  pincode: '411001',
};

interface Customer {
  userId: string;
  token: string;
}

async function customer(): Promise<Customer> {
  const user = await prisma.user.create({
    data: { phone: `+9196${randomInt(10_000_000, 99_999_999)}` },
  });
  f.userIds.push(user.id);
  const { token } = await app
    .get(TokenService)
    .signAccessToken({ userId: user.id, sessionId: randomUUID() });
  return { userId: user.id, token };
}

const ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
function http(c: Customer, method: 'get' | 'post' | 'patch', path: string) {
  return request(app.getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${c.token}`)
    .set('X-Forwarded-For', ip());
}

/** A customer with a ₹699 15-pack in an unpaid prepaid order. */
async function unpaidOrder(c?: Customer): Promise<{ c: Customer; order: OrderDetail }> {
  const who = c ?? (await customer());
  await http(who, 'post', '/v1/cart/items').send({ variantId: f.fifteen }).expect(200);
  const res = await http(who, 'post', '/v1/checkout')
    .set('Idempotency-Key', randomUUID())
    .send({ paymentMethod: 'prepaid', address: ADDRESS })
    .expect(201);
  return { c: who, order: orderDetailSchema.parse(res.body) };
}

function verify(c: Customer, razorpayOrderId: string, paymentId: string, signature: string) {
  return http(c, 'post', '/v1/payments/verify').send({
    razorpayOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: signature,
  });
}

/** Sends a webhook exactly as Razorpay would: raw JSON body + HMAC header + event id. */
function webhook(
  body: object,
  eventId = `evt_${run}_${randomUUID().slice(0, 8)}`,
  secret = FAKE_WEBHOOK_SECRET,
) {
  f.eventIds.push(eventId);
  const raw = JSON.stringify(body);
  return request(app.getHttpServer())
    .post('/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', webhookSignature(secret, raw))
    .set('X-Razorpay-Event-Id', eventId)
    .send(raw);
}

const paymentEvent = (event: string, entity: Record<string, unknown>) => ({
  entity: 'event',
  event,
  contains: ['payment'],
  payload: { payment: { entity: { entity: 'payment', currency: 'INR', ...entity } } },
  created_at: Math.floor(Date.now() / 1000),
});

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for background job');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const orderRow = (number: string) =>
  prisma.order.findUniqueOrThrow({
    where: { number },
    include: { events: { orderBy: { id: 'asc' } }, payments: true, refunds: true },
  });
const stock = () =>
  prisma.variant.findUniqueOrThrow({
    where: { id: f.fifteen },
    select: { stock: true, reservedStock: true },
  });

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    TRUST_PROXY: '1',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }),
  );
  await app.init();
  prisma = app.get(PrismaService);
  gateway = app.get<FakeGateway>(PAYMENT_GATEWAY);

  const product = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-latte`,
      name: 'Test latte',
      type: 'coffee',
      variants: {
        create: {
          sku: `T-${run}-FIFTEEN`,
          name: '15 sachets',
          packSize: 15,
          mrpPaise: 69900,
          pricePaise: 69900,
          hsnCode: '2101',
          gstRateBps: 500,
          stock: 100,
          weightG: 330,
        },
      },
    },
    include: { variants: true },
  });
  f.productIds.push(product.id);
  f.fifteen = product.variants[0]!.id;
});

afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    const orderIds = (
      await tx.order.findMany({ where: { customerId: { in: f.userIds } }, select: { id: true } })
    ).map((o) => o.id);
    await tx.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
  });
  await prisma.webhookEvent.deleteMany({ where: { externalEventId: { in: f.eventIds } } });
  await prisma.cart.deleteMany({ where: { userId: { in: f.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await prisma.variant.deleteMany({ where: { productId: { in: f.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: f.productIds } } });
  await app.close();
});

describe('checkout → Razorpay order', () => {
  it('returns Checkout details for the exact order total', async () => {
    const { order } = await unpaidOrder();
    expect(order.status).toBe('pending_payment');
    expect(order.payment).toMatchObject({
      provider: 'razorpay',
      keyId: FAKE_KEY_ID,
      currency: 'INR',
      amountPaise: 69900,
    });
    expect(gateway.orders.get(order.payment!.razorpayOrderId)?.amountPaise).toBe(69900);
  });

  it('recovers from a Razorpay outage when the client retries with the same key', async () => {
    const c = await customer();
    await http(c, 'post', '/v1/cart/items').send({ variantId: f.fifteen }).expect(200);
    const key = randomUUID();
    gateway.failNextCreateOrder = true;
    const first = await http(c, 'post', '/v1/checkout')
      .set('Idempotency-Key', key)
      .send({ paymentMethod: 'prepaid', address: ADDRESS })
      .expect(503);
    expect(errorResponseSchema.parse(first.body).error.code).toBe('SERVICE_UNAVAILABLE');

    const retry = await http(c, 'post', '/v1/checkout')
      .set('Idempotency-Key', key)
      .send({ paymentMethod: 'prepaid', address: ADDRESS })
      .expect(200);
    const order = orderDetailSchema.parse(retry.body);
    expect(order.payment?.razorpayOrderId).toMatch(/^order_/);
    expect((await orderRow(order.number)).payments).toHaveLength(1);
  });
});

describe('POST /v1/payments/verify', () => {
  it('confirms the order: stock taken, hold released, payment captured', async () => {
    const { c, order } = await unpaidOrder();
    const held = await stock();
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId);

    const res = await verify(c, order.payment!.razorpayOrderId, paymentId, signature).expect(200);
    const confirmed = orderDetailSchema.parse(res.body);
    expect(confirmed).toMatchObject({ status: 'confirmed', payment: null, payBy: null });
    expect(await stock()).toEqual({ stock: held.stock - 1, reservedStock: held.reservedStock - 1 });
    const row = await orderRow(order.number);
    expect(row.payments[0]).toMatchObject({
      status: 'captured',
      razorpayPaymentId: paymentId,
      method: 'upi',
    });

    // Verifying again changes nothing.
    await verify(c, order.payment!.razorpayOrderId, paymentId, signature).expect(200);
    expect(
      (await orderRow(order.number)).events.filter((e) => e.toStatus === 'confirmed'),
    ).toHaveLength(1);
  });

  it('captures an authorised-only payment before confirming', async () => {
    const { c, order } = await unpaidOrder();
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId, {
      status: 'authorized',
    });
    const res = await verify(c, order.payment!.razorpayOrderId, paymentId, signature).expect(200);
    expect(res.body.status).toBe('confirmed');
    expect(gateway.payments.get(paymentId)?.status).toBe('captured');
  });

  it('rejects a bad signature and leaves the order unpaid', async () => {
    const { c, order } = await unpaidOrder();
    const { paymentId } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    const res = await verify(c, order.payment!.razorpayOrderId, paymentId, 'a'.repeat(64)).expect(
      400,
    );
    expect(errorResponseSchema.parse(res.body).error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect((await orderRow(order.number)).status).toBe('pending_payment');
  });

  it("rejects a payment whose amount doesn't match the order", async () => {
    const { c, order } = await unpaidOrder();
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId, {
      amountPaise: 100,
    });
    const res = await verify(c, order.payment!.razorpayOrderId, paymentId, signature).expect(400);
    expect(res.body.error.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect((await orderRow(order.number)).status).toBe('pending_payment');
  });

  it("can't verify another customer's payment", async () => {
    const { order } = await unpaidOrder();
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    await verify(await customer(), order.payment!.razorpayOrderId, paymentId, signature).expect(
      404,
    );
  });
});

describe('Razorpay webhooks', () => {
  it('§10: payment captured but the client never returned → the webhook confirms the order', async () => {
    const { order } = await unpaidOrder();
    const { paymentId } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    const res = await webhook(
      paymentEvent('payment.captured', {
        id: paymentId,
        order_id: order.payment!.razorpayOrderId,
        amount: 69900,
        status: 'captured',
        method: 'card',
      }),
    ).expect(200);
    expect(res.body).toEqual({ received: true });

    const row = await waitFor(async () => {
      const r = await orderRow(order.number);
      return r.status === 'confirmed' && r;
    });
    expect(row.events.at(-1)).toMatchObject({ toStatus: 'confirmed', actor: 'webhook' });
    expect(row.payments[0]).toMatchObject({ status: 'captured', method: 'card' });
  });

  it('§10: a duplicate delivery is stored and processed once', async () => {
    const { c, order } = await unpaidOrder();
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    const body = paymentEvent('payment.captured', {
      id: paymentId,
      order_id: order.payment!.razorpayOrderId,
      amount: 69900,
      status: 'captured',
    });
    const eventId = `evt_${run}_dup_${randomUUID().slice(0, 6)}`;
    await webhook(body, eventId).expect(200);
    await webhook(body, eventId).expect(200);
    // …and the client's verify arrives too.
    await verify(c, order.payment!.razorpayOrderId, paymentId, signature).expect(200);

    await waitFor(() =>
      prisma.webhookEvent.findFirst({
        where: { externalEventId: eventId, processedAt: { not: null } },
      }),
    );
    expect(await prisma.webhookEvent.count({ where: { externalEventId: eventId } })).toBe(1);
    const row = await orderRow(order.number);
    expect(row.events.filter((e) => e.toStatus === 'confirmed')).toHaveLength(1);
  });

  it('rejects a bad signature without storing anything', async () => {
    const eventId = `evt_${run}_bad`;
    const res = await webhook(
      paymentEvent('payment.captured', {
        id: 'pay_x',
        order_id: 'order_x',
        amount: 1,
        status: 'captured',
      }),
      eventId,
      'wrong-secret',
    ).expect(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await prisma.webhookEvent.count({ where: { externalEventId: eventId } })).toBe(0);
  });

  it('a failed attempt keeps the stock held; a later successful attempt confirms', async () => {
    const { c, order } = await unpaidOrder();
    const rzpOrderId = order.payment!.razorpayOrderId;
    const held = await stock();
    await webhook(
      paymentEvent('payment.failed', {
        id: `pay_fail${randomInt(1e6)}`,
        order_id: rzpOrderId,
        amount: 69900,
        status: 'failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Payment declined by bank',
      }),
    ).expect(200);
    await waitFor(async () => (await orderRow(order.number)).status === 'payment_failed');
    expect(await stock()).toEqual(held);

    // The customer retries on the same Razorpay order.
    const detail = orderDetailSchema.parse(
      (await http(c, 'get', `/v1/orders/${order.number}`).expect(200)).body,
    );
    expect(detail.payment?.razorpayOrderId).toBe(rzpOrderId);
    const { paymentId, signature } = gateway.simulatePayment(rzpOrderId);
    const res = await verify(c, rzpOrderId, paymentId, signature).expect(200);
    expect(res.body.status).toBe('confirmed');
  });

  it('refunds a payment that arrives after the order expired', async () => {
    const { order } = await unpaidOrder();
    const rzpOrderId = order.payment!.razorpayOrderId;
    await prisma.order.update({
      where: { number: order.number },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });
    await app.get(OrdersService).expireReservations();
    expect((await orderRow(order.number)).status).toBe('cancelled');

    const { paymentId } = gateway.simulatePayment(rzpOrderId);
    await webhook(
      paymentEvent('payment.captured', {
        id: paymentId,
        order_id: rzpOrderId,
        amount: 69900,
        status: 'captured',
      }),
    ).expect(200);

    const refund = await waitFor(async () => {
      const r = (await orderRow(order.number)).refunds[0];
      return r?.razorpayRefundId ? r : null;
    });
    expect(refund).toMatchObject({ amountPaise: 69900, createdBy: 'system' });
    expect([...gateway.refunds.values()].find((r) => r.refundRef === refund.id)?.paymentId).toBe(
      paymentId,
    );
    expect((await orderRow(order.number)).status).toBe('cancelled');
  });

  it('stores unknown events and marks them processed', async () => {
    const eventId = `evt_${run}_other`;
    await webhook({ entity: 'event', event: 'order.paid', payload: {} }, eventId).expect(200);
    await waitFor(() =>
      prisma.webhookEvent.findFirst({
        where: { externalEventId: eventId, processedAt: { not: null } },
      }),
    );
  });
});

describe('cancelling a paid order', () => {
  it('restocks, refunds in full in the background, and tracks the refund to processed', async () => {
    const { c, order } = await unpaidOrder();
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    await verify(c, order.payment!.razorpayOrderId, paymentId, signature).expect(200);
    const paid = await stock();

    const res = await http(c, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    const cancelled = orderDetailSchema.parse(res.body);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      refund: { status: 'pending', amountPaise: 69900 },
    });
    expect(await stock()).toEqual({ stock: paid.stock + 1, reservedStock: paid.reservedStock });

    const refund = await waitFor(async () => {
      const r = (await orderRow(order.number)).refunds[0];
      return r?.razorpayRefundId ? r : null;
    });
    await webhook({
      entity: 'event',
      event: 'refund.processed',
      contains: ['refund', 'payment'],
      payload: {
        refund: {
          entity: {
            id: refund.razorpayRefundId,
            payment_id: paymentId,
            amount: 69900,
            status: 'processed',
            notes: { refund_ref: refund.id },
          },
        },
      },
    }).expect(200);
    await waitFor(
      async () =>
        (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status ===
        'processed',
    );

    const detail = orderDetailSchema.parse(
      (await http(c, 'get', `/v1/orders/${order.number}`).expect(200)).body,
    );
    expect(detail.refund).toEqual({ status: 'processed', amountPaise: 69900 });
  });
});
