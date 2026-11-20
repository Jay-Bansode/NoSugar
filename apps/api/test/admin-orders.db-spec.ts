/**
 * Admin orders: list/search, detail, pack, cancel, refunds (Razorpay and manual COD) with credit
 * notes, roles, idempotency and the audit log, against real Postgres + Redis + BullMQ.
 * Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  type AdminOrderDetail,
  adminOrderDetailSchema,
  adminOrderSummarySchema,
  errorResponseSchema,
  type OrderDetail,
  orderDetailSchema,
  type OrderStatus,
} from '@brand/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { FakeGateway } from '../src/modules/payments/fake.gateway.js';
import { PAYMENT_GATEWAY } from '../src/modules/payments/gateway.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestAdmin, deleteTestAdmins, type TestAdmin } from './helpers/admin.js';
import { TEST_ENV } from './helpers/env.js';
import { deleteTestOrders } from './helpers/orders.js';

const run = randomUUID().slice(0, 8).toUpperCase();
let app: NestExpressApplication;
let prisma: PrismaService;
let gateway: FakeGateway;
const f = {
  productIds: [] as string[],
  userIds: [] as string[],
  adminIds: [] as string[],
  fifteen: '',
};
const admins = {} as Record<'owner' | 'operations' | 'support', TestAdmin>;

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
  phone: string;
}

async function customer(): Promise<Customer> {
  const phone = `+9193${randomInt(10_000_000, 99_999_999)}`;
  const user = await prisma.user.create({ data: { phone } });
  f.userIds.push(user.id);
  const { token } = await app
    .get(TokenService)
    .signAccessToken({ userId: user.id, sessionId: randomUUID() });
  return { userId: user.id, token, phone };
}

const ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
function as(token: string, method: 'get' | 'post', path: string) {
  return request(app.getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Forwarded-For', ip());
}
const code = (res: request.Response) => errorResponseSchema.parse(res.body).error.code;

async function placeOrder(c: Customer, paymentMethod: 'cod' | 'prepaid'): Promise<OrderDetail> {
  await as(c.token, 'post', '/v1/cart/items').send({ variantId: f.fifteen }).expect(200);
  const res = await as(c.token, 'post', '/v1/checkout')
    .set('Idempotency-Key', randomUUID())
    .send({ paymentMethod, address: ADDRESS })
    .expect(201);
  const order = orderDetailSchema.parse(res.body);
  if (paymentMethod === 'prepaid') {
    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    await as(c.token, 'post', '/v1/payments/verify')
      .send({
        razorpayOrderId: order.payment!.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      })
      .expect(200);
  }
  return order;
}

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

const waitForInvoice = (number: string) =>
  waitFor(() => prisma.invoice.findFirst({ where: { order: { number } } }));

/** Moves an order along as the courier would (Shiprocket arrives in Phase 3). */
async function advance(number: string, ...statuses: OrderStatus[]): Promise<void> {
  const { id } = await prisma.order.findUniqueOrThrow({ where: { number } });
  for (const to of statuses) {
    await prisma.$transaction((tx) =>
      app.get(OrdersService).transition(tx, id, to, { actor: 'system' }),
    );
  }
}

/** A paid, invoiced, delivered order. */
async function delivered(paymentMethod: 'cod' | 'prepaid'): Promise<OrderDetail> {
  const order = await placeOrder(await customer(), paymentMethod);
  await waitForInvoice(order.number);
  await advance(order.number, 'packed', 'shipped', 'delivered');
  return order;
}

function refund(admin: TestAdmin, number: string, body: object, key: string | null = randomUUID()) {
  const req = as(admin.token, 'post', `/v1/admin/orders/${number}/refunds`);
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
}
const detailOf = (res: request.Response): AdminOrderDetail =>
  adminOrderDetailSchema.parse(res.body);
const auditFor = (number: string) =>
  prisma.auditLog.findMany({
    where: { entityType: 'order', entityId: number },
    orderBy: { id: 'asc' },
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

  for (const role of ['owner', 'operations', 'support'] as const) {
    admins[role] = await createTestAdmin(app, role, run);
    f.adminIds.push(admins[role].id);
  }
  const product = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-admin-orders`,
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
          stock: 500,
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
  await deleteTestOrders(prisma, f.userIds);
  await deleteTestAdmins(prisma, f.adminIds);
  await prisma.cart.deleteMany({ where: { userId: { in: f.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await prisma.variant.deleteMany({ where: { productId: { in: f.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: f.productIds } } });
  await app.close();
});

describe('looking up orders', () => {
  it('lists, filters and searches by order number or mobile number, for every role', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod');

    for (const role of ['owner', 'operations', 'support'] as const) {
      const res = await as(admins[role].token, 'get', `/v1/admin/orders?q=${order.number}`).expect(
        200,
      );
      const rows = (res.body as { data: unknown[] }).data.map((r) =>
        adminOrderSummarySchema.parse(r),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        number: order.number,
        customerName: 'Asha Rao',
        city: 'Pune',
        customerPhone: c.phone,
      });
    }
    const byPhone = await as(
      admins.support.token,
      'get',
      `/v1/admin/orders?q=${c.phone.slice(3)}`,
    ).expect(200);
    expect((byPhone.body as { data: { number: string }[] }).data.map((r) => r.number)).toEqual([
      order.number,
    ]);

    const confirmed = await as(
      admins.owner.token,
      'get',
      '/v1/admin/orders?status=confirmed&limit=100',
    ).expect(200);
    for (const r of (confirmed.body as { data: { status: string }[] }).data)
      expect(r.status).toBe('confirmed');
  });

  it('shows the whole order to staff, and nothing to customers', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'prepaid');
    const detail = detailOf(
      await as(admins.support.token, 'get', `/v1/admin/orders/${order.number}`).expect(200),
    );
    expect(detail).toMatchObject({
      status: 'confirmed',
      customer: { phone: c.phone },
      lines: [{ sku: expect.stringMatching(/^T-/), hsnCode: '2101', gstRateBps: 500, quantity: 1 }],
      payments: [{ status: 'captured', amountPaise: 69900 }],
      refundablePaise: 69900,
      can: { pack: true, cancel: true, refund: false },
    });
    expect(detail.timeline.map((t) => t.to)).toEqual(['pending_payment', 'confirmed']);

    await as(c.token, 'get', `/v1/admin/orders/${order.number}`).expect(401);
    await as(admins.support.token, 'get', '/v1/admin/orders/BR9999999').expect(404);
  });
});

describe('packing and cancelling', () => {
  it('operations can pack; support cannot', async () => {
    const order = await placeOrder(await customer(), 'cod');
    expect(
      code(
        await as(admins.support.token, 'post', `/v1/admin/orders/${order.number}/pack`).expect(403),
      ),
    ).toBe('FORBIDDEN');
    const packed = detailOf(
      await as(admins.operations.token, 'post', `/v1/admin/orders/${order.number}/pack`).expect(
        200,
      ),
    );
    expect(packed).toMatchObject({ status: 'packed', can: { pack: false, cancel: true } });
    expect(packed.timeline.at(-1)).toMatchObject({
      from: 'confirmed',
      to: 'packed',
      actor: 'admin',
    });
    const audit = await auditFor(order.number);
    expect(audit.map((a) => [a.action, a.adminUserId])).toEqual([
      ['order.pack', admins.operations.id],
    ]);
    // Packing twice is refused by the state machine.
    expect(
      code(
        await as(admins.operations.token, 'post', `/v1/admin/orders/${order.number}/pack`).expect(
          409,
        ),
      ),
    ).toBe('CONFLICT');
  });

  it('support can cancel a paid order before dispatch: restocked, refunded, credited', async () => {
    const order = await placeOrder(await customer(), 'prepaid');
    const invoice = await waitForInvoice(order.number);
    const before = await prisma.variant.findUniqueOrThrow({ where: { id: f.fifteen } });

    await as(admins.support.token, 'post', `/v1/admin/orders/${order.number}/cancel`)
      .send({ reason: 'x' })
      .expect(400);
    const cancelled = detailOf(
      await as(admins.support.token, 'post', `/v1/admin/orders/${order.number}/cancel`)
        .send({ reason: 'Customer called to cancel' })
        .expect(200),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      refundablePaise: 0,
      can: { cancel: false, refund: false },
    });
    expect(cancelled.refunds).toMatchObject([{ amountPaise: 69900, method: 'razorpay' }]);
    expect(cancelled.creditNotes).toMatchObject([{ totalPaise: invoice.totalPaise }]);
    expect((await prisma.variant.findUniqueOrThrow({ where: { id: f.fifteen } })).stock).toBe(
      before.stock + 1,
    );
    await waitFor(
      async () =>
        (await prisma.refund.findFirst({
          // Sent to Razorpay by the job; "processed" follows with the refund.processed webhook.
          where: { order: { number: order.number }, razorpayRefundId: { not: null } },
        })) ?? null,
    );

    const [audit] = await auditFor(order.number);
    expect(audit).toMatchObject({ action: 'order.cancel', adminUserId: admins.support.id });
    expect(audit!.changes).toMatchObject({
      reason: 'Customer called to cancel',
      from: 'confirmed',
    });
  });

  it('refuses to cancel after dispatch', async () => {
    const order = await placeOrder(await customer(), 'cod');
    await advance(order.number, 'packed', 'shipped');
    const res = await as(admins.owner.token, 'post', `/v1/admin/orders/${order.number}/cancel`)
      .send({ reason: 'Too late' })
      .expect(409);
    expect(code(res)).toBe('ORDER_NOT_CANCELLABLE');
  });
});

describe('refunds after delivery', () => {
  it('a partial then a final online refund, each with a credit note', async () => {
    const order = await delivered('prepaid');
    const first = detailOf(
      await refund(admins.owner, order.number, {
        amountPaise: 20000,
        reason: 'One pack damaged',
        method: 'razorpay',
      }).expect(200),
    );
    expect(first).toMatchObject({ status: 'partially_refunded', refundablePaise: 49900 });
    expect(first.refunds).toMatchObject([
      { amountPaise: 20000, method: 'razorpay', reference: null },
    ]);
    expect(first.creditNotes).toMatchObject([{ totalPaise: 20000 }]);
    const note = await prisma.creditNote.findFirstOrThrow({
      where: { refund: { order: { number: order.number } } },
    });
    expect(note).toMatchObject({ totalPaise: 20000, reason: 'Refund: One pack damaged' });
    // Issued with Razorpay by the background job.
    await waitFor(
      async () =>
        (await prisma.refund.findFirst({
          where: { id: first.refunds[0]!.id, razorpayRefundId: { not: null } },
        })) ?? null,
    );

    const second = detailOf(
      await refund(admins.owner, order.number, {
        amountPaise: 49900,
        reason: 'Goodwill',
        method: 'razorpay',
      }).expect(200),
    );
    expect(second).toMatchObject({
      status: 'refunded',
      refundablePaise: 0,
      can: { refund: false },
    });
    expect(second.creditNotes.reduce((s, c) => s + c.totalPaise, 0)).toBe(69900);
    expect((await auditFor(order.number)).map((a) => a.action)).toEqual([
      'order.refund',
      'order.refund',
    ]);
  });

  it('refuses more than is refundable, other roles, and requests without an Idempotency-Key', async () => {
    const order = await delivered('prepaid');
    const body = { amountPaise: 69901, reason: 'Too much', method: 'razorpay' };
    expect(code(await refund(admins.owner, order.number, body).expect(409))).toBe(
      'REFUND_NOT_ALLOWED',
    );
    expect(
      code(
        await refund(admins.operations, order.number, { ...body, amountPaise: 100 }).expect(403),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await refund(admins.owner, order.number, { ...body, amountPaise: 100 }, null).expect(400),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(await prisma.refund.count({ where: { order: { number: order.number } } })).toBe(0);
  });

  it('the same Idempotency-Key never refunds twice, even when sent at the same time', async () => {
    const order = await delivered('prepaid');
    const key = randomUUID();
    const body = { amountPaise: 10000, reason: 'Late delivery', method: 'razorpay' };
    await Promise.all([
      refund(admins.owner, order.number, body, key),
      refund(admins.owner, order.number, body, key),
    ]);
    await refund(admins.owner, order.number, body, key).expect(200);
    expect(await prisma.refund.count({ where: { order: { number: order.number } } })).toBe(1);
  });

  it('COD is refunded manually with a reference, and the COD fee is kept', async () => {
    const order = await delivered('cod');
    const viaRazorpay = await refund(admins.owner, order.number, {
      amountPaise: 1000,
      reason: 'Damaged',
      method: 'razorpay',
    }).expect(409);
    expect(errorResponseSchema.parse(viaRazorpay.body).error.message).toMatch(/manual refund/);
    await refund(admins.owner, order.number, {
      amountPaise: 1000,
      reason: 'Damaged',
      method: 'manual',
    }).expect(400);

    const detail = detailOf(
      await as(admins.owner.token, 'get', `/v1/admin/orders/${order.number}`).expect(200),
    );
    expect(detail.refundablePaise).toBe(order.totals.totalPaise - order.totals.codFeePaise);
    const done = detailOf(
      await refund(admins.owner, order.number, {
        amountPaise: detail.refundablePaise,
        reason: 'Customer returned it',
        method: 'manual',
        reference: 'UPI-UTR-123456789',
      }).expect(200),
    );
    expect(done.status).toBe('refunded');
    expect(done.refunds).toMatchObject([
      { method: 'manual', status: 'processed', reference: 'UPI-UTR-123456789' },
    ]);
    expect(done.refunds[0]!.processedAt).not.toBeNull();
  });

  it('a returned order is refunded in full only, without a second credit note', async () => {
    const order = await placeOrder(await customer(), 'prepaid');
    await waitForInvoice(order.number);
    await advance(order.number, 'packed', 'shipped', 'rto', 'returned');
    const credited = await prisma.creditNote.count({
      where: { invoice: { order: { number: order.number } } },
    });
    expect(credited).toBe(1); // issued when it came back

    const partial = await refund(admins.owner, order.number, {
      amountPaise: 100,
      reason: 'Partial',
      method: 'razorpay',
    }).expect(409);
    expect(errorResponseSchema.parse(partial.body).error.message).toMatch(/in full/);
    const done = detailOf(
      await refund(admins.owner, order.number, {
        amountPaise: 69900,
        reason: 'Returned to us',
        method: 'razorpay',
      }).expect(200),
    );
    expect(done.status).toBe('refunded');
    expect(
      await prisma.creditNote.count({ where: { invoice: { order: { number: order.number } } } }),
    ).toBe(1);
  });

  it('refuses orders that have not been delivered', async () => {
    const order = await placeOrder(await customer(), 'prepaid');
    const res = await refund(admins.owner, order.number, {
      amountPaise: 100,
      reason: 'Too early',
      method: 'razorpay',
    }).expect(409);
    expect(errorResponseSchema.parse(res.body).error.message).toMatch(/cancel/);
  });
});

describe('documents', () => {
  it('staff can download the invoice and credit notes', async () => {
    const order = await delivered('prepaid');
    const done = detailOf(
      await refund(admins.owner, order.number, {
        amountPaise: 5000,
        reason: 'Damaged lid',
        method: 'razorpay',
      }).expect(200),
    );
    const invoice = await as(
      admins.support.token,
      'get',
      `/v1/admin/orders/${order.number}/invoice`,
    )
      .buffer(true)
      .expect(200);
    expect(invoice.headers['content-type']).toBe('application/pdf');
    const note = await as(
      admins.support.token,
      'get',
      `/v1/admin/orders/${order.number}/credit-notes/${done.creditNotes[0]!.id}`,
    )
      .buffer(true)
      .expect(200);
    expect(note.headers['content-disposition']).toMatch(/^attachment; filename="CN-/);
  });
});
