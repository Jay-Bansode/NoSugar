/**
 * Checkout and orders over HTTP against real Postgres + Redis (stub serviceability).
 * Covers CLAUDE.md §10 edge cases: last unit raced by two customers, second trial kit,
 * idempotent retries. Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  errorResponseSchema,
  type OrderDetail,
  orderDetailSchema,
  orderSummarySchema,
  paginated,
} from '@brand/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';

const run = randomUUID().slice(0, 8).toUpperCase();
let app: NestExpressApplication;
let prisma: PrismaService;

const f = {
  productIds: [] as string[],
  userIds: [] as string[],
  discountIds: [] as string[],
  six: '',
  fifteen: '',
  last: '',
  trial: '',
  limitedCode: `T${run}ONCE`,
};

const PUNE = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Pune',
  stateCode: '27',
  pincode: '411001',
};
const ANDAMAN = { ...PUNE, city: 'Port Blair', stateCode: '35', pincode: '744101' }; // stub: not serviceable
const SHILLONG = { ...PUNE, city: 'Shillong', stateCode: '17', pincode: '793001' }; // stub: no COD

interface Customer {
  userId: string;
  token: string;
  ip: string;
}

async function customer(): Promise<Customer> {
  const user = await prisma.user.create({
    data: { phone: `+9197${randomInt(10_000_000, 99_999_999)}` },
  });
  f.userIds.push(user.id);
  const { token } = await app
    .get(TokenService)
    .signAccessToken({ userId: user.id, sessionId: randomUUID() });
  return {
    userId: user.id,
    token,
    ip: `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`,
  };
}

function http(c: Customer | null, method: 'get' | 'post' | 'patch', path: string) {
  let req = request(app.getHttpServer())
    [method](path)
    .set('X-Forwarded-For', c?.ip ?? '10.0.0.1');
  if (c) req = req.set('Authorization', `Bearer ${c.token}`);
  return req;
}

async function add(c: Customer, item: object) {
  await http(c, 'post', '/v1/cart/items').send(item).expect(200);
}

function checkout(c: Customer | null, body: object, key: string | null = randomUUID()) {
  const req = http(c, 'post', '/v1/checkout');
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
}

async function placed(c: Customer, body: object, key = randomUUID()): Promise<OrderDetail> {
  const res = await checkout(c, body, key).expect(201);
  return orderDetailSchema.parse(res.body);
}

function expectCode(res: request.Response, code: string) {
  expect(errorResponseSchema.parse(res.body).error.code).toBe(code);
}

const stockOf = async (variantId: string) =>
  prisma.variant.findUniqueOrThrow({
    where: { id: variantId },
    select: { stock: true, reservedStock: true },
  });

const orderRow = (number: string) =>
  prisma.order.findUniqueOrThrow({
    where: { number },
    include: { events: { orderBy: { id: 'asc' } }, items: true },
  });

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    TRUST_PROXY: '1',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
  prisma = app.get(PrismaService);

  const v = (name: string, price: number, packSize: number, stock: number) => ({
    sku: `T-${run}-${name}`,
    name,
    packSize,
    mrpPaise: price,
    pricePaise: price,
    hsnCode: '2101',
    gstRateBps: 500,
    stock,
    weightG: 150,
  });
  const coffee = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-latte`,
      name: 'Test latte',
      type: 'coffee',
      variants: {
        create: [v('SIX', 29900, 6, 50), v('FIFTEEN', 69900, 15, 50), v('LAST', 29900, 6, 1)],
      },
    },
    include: { variants: true },
  });
  const trial = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-trial`,
      name: 'Test trial kit',
      type: 'trial_kit',
      onePerCustomer: true,
      variants: { create: [{ ...v('TRIAL', 39900, 5, 50), gstRateBps: 1800 }] },
    },
    include: { variants: true },
  });
  f.productIds.push(coffee.id, trial.id);
  const id = (n: string) => coffee.variants.find((x) => x.name === n)!.id;
  f.six = id('SIX');
  f.fifteen = id('FIFTEEN');
  f.last = id('LAST');
  f.trial = trial.variants[0]!.id;

  const d = await prisma.discount.create({
    data: { code: f.limitedCode, type: 'fixed', valuePaise: 5000, usageLimit: 1 },
  });
  f.discountIds.push(d.id);
});

afterAll(async () => {
  // order_events is append-only by trigger; test cleanup disables triggers for this
  // transaction only (session_replication_role resets when it ends).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    const orders = await tx.order.findMany({
      where: { customerId: { in: f.userIds } },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    // Triggers (and so foreign keys) are off here: delete every child table explicitly.
    await tx.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.discountRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
  });
  await prisma.cart.deleteMany({ where: { userId: { in: f.userIds } } });
  await prisma.address.deleteMany({ where: { userId: { in: f.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await prisma.discount.deleteMany({ where: { id: { in: f.discountIds } } });
  await prisma.variant.deleteMany({ where: { productId: { in: f.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: f.productIds } } });
  await app.close();
});

describe('placing orders', () => {
  it('COD: confirmed at once, stock taken, prices and address snapshotted, cart emptied', async () => {
    const c = await customer();
    await add(c, { variantId: f.six, quantity: 2 });
    const before = await stockOf(f.six);

    const order = await placed(c, { paymentMethod: 'cod', address: PUNE, saveAddress: true });
    expect(order.number).toMatch(/^BR\d{7,}$/);
    expect(order).toMatchObject({
      status: 'confirmed',
      paymentMethod: 'cod',
      payBy: null,
      canCancel: true,
      totals: { subtotalPaise: 59800, shippingPaise: 0, codFeePaise: 4900, totalPaise: 64700 },
      shippingAddress: { phone: '+919876543210', state: 'Maharashtra', stateCode: '27' },
      lines: [
        {
          name: 'Test latte',
          variantName: 'SIX',
          sku: `T-${run}-SIX`,
          quantity: 2,
          unitPricePaise: 29900,
        },
      ],
    });
    expect(order.timeline.map((t) => t.status)).toEqual(['confirmed']);

    expect(await stockOf(f.six)).toEqual({
      stock: before.stock - 2,
      reservedStock: before.reservedStock,
    });
    const row = await orderRow(order.number);
    expect(row.items[0]).toMatchObject({ hsnCode: '2101', gstRateBps: 500, discountPaise: 0 });
    expect(row.events[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'confirmed',
      actor: 'customer',
    });
    const cart = await http(c, 'get', '/v1/cart').expect(200);
    expect(cart.body.lines).toEqual([]);
    expect(await prisma.address.findMany({ where: { userId: c.userId } })).toEqual([
      expect.objectContaining({ pincode: '411001', isDefault: true }),
    ]);
  });

  it('prepaid: waits for payment and only reserves stock', async () => {
    const c = await customer();
    await add(c, { variantId: f.fifteen });
    const before = await stockOf(f.fifteen);
    const order = await placed(c, { paymentMethod: 'prepaid', address: PUNE });

    expect(order.status).toBe('pending_payment');
    const minutesLeft = (new Date(order.payBy!).getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(28);
    expect(minutesLeft).toBeLessThanOrEqual(30);
    expect(await stockOf(f.fifteen)).toEqual({
      stock: before.stock,
      reservedStock: before.reservedStock + 1,
    });
  });

  it('replays an Idempotency-Key instead of placing a second order', async () => {
    const c = await customer();
    await add(c, { variantId: f.fifteen });
    const key = randomUUID();
    const first = await placed(c, { paymentMethod: 'prepaid', address: PUNE }, key);
    const reserved = (await stockOf(f.fifteen)).reservedStock;

    const again = await checkout(c, { paymentMethod: 'prepaid', address: PUNE }, key).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.number).toBe(first.number);
    expect((await stockOf(f.fifteen)).reservedStock).toBe(reserved);
    expect(await prisma.order.count({ where: { customerId: c.userId } })).toBe(1);
  });

  it('requires login and a UUID Idempotency-Key', async () => {
    const c = await customer();
    expectCode(
      await checkout(null, { paymentMethod: 'cod', address: PUNE }).expect(401),
      'UNAUTHORIZED',
    );
    expectCode(
      await checkout(c, { paymentMethod: 'cod', address: PUNE }, null).expect(400),
      'VALIDATION_FAILED',
    );
    const req = http(c, 'post', '/v1/checkout').set('Idempotency-Key', 'abc');
    expectCode(
      await req.send({ paymentMethod: 'cod', address: PUNE }).expect(400),
      'VALIDATION_FAILED',
    );
  });

  it('rejects an empty cart', async () => {
    expectCode(
      await checkout(await customer(), { paymentMethod: 'cod', address: PUNE }).expect(422),
      'CART_EMPTY',
    );
  });

  it('checks delivery and COD for the PIN code, leaving the cart untouched', async () => {
    const c = await customer();
    await add(c, { variantId: f.six });
    expectCode(
      await checkout(c, { paymentMethod: 'cod', address: ANDAMAN }).expect(422),
      'NOT_SERVICEABLE',
    );
    expectCode(
      await checkout(c, { paymentMethod: 'cod', address: SHILLONG }).expect(422),
      'COD_UNAVAILABLE',
    );
    // Prepaid to the same PIN is fine.
    await placed(c, { paymentMethod: 'prepaid', address: SHILLONG });
  });

  it('refuses a cart with unavailable lines', async () => {
    const c = await customer();
    await add(c, { variantId: f.six });
    await prisma.variant.update({ where: { id: f.six }, data: { isActive: false } });
    try {
      const res = await checkout(c, { paymentMethod: 'cod', address: PUNE }).expect(409);
      expectCode(res, 'CART_HAS_ISSUES');
      expect(res.body.error.details.lines).toEqual([
        expect.objectContaining({ issue: 'UNAVAILABLE' }),
      ]);
    } finally {
      await prisma.variant.update({ where: { id: f.six }, data: { isActive: true } });
    }
  });
});

describe('§10 edge cases', () => {
  it('second trial kit for the same customer is refused at checkout', async () => {
    const c = await customer();
    await add(c, { variantId: f.trial });
    await placed(c, { paymentMethod: 'cod', address: PUNE });

    // Different address, and the item forced back into the cart (bypassing the cart check).
    const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: c.userId } });
    await prisma.cartItem.create({ data: { cartId: cart.id, variantId: f.trial, quantity: 1 } });
    const res = await checkout(c, {
      paymentMethod: 'cod',
      address: { ...PUNE, line1: '99 Other Street', pincode: '411045' },
    }).expect(409);
    // Caught before the transaction: the cart flags the line, so the customer sees which one.
    expectCode(res, 'CART_HAS_ISSUES');
    expect(res.body.error.details.lines).toEqual([
      expect.objectContaining({ issue: 'PURCHASE_LIMIT' }),
    ]);
    expect(await prisma.order.count({ where: { customerId: c.userId } })).toBe(1);
  });

  it('two customers racing for the last unit: exactly one wins', async () => {
    const [a, b] = [await customer(), await customer()];
    await add(a, { variantId: f.last });
    await add(b, { variantId: f.last });
    const results = await Promise.all([
      checkout(a, { paymentMethod: 'cod', address: PUNE }),
      checkout(b, { paymentMethod: 'cod', address: PUNE }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expectCode(
      results.find((r) => r.status === 409)!,
      'OUT_OF_STOCK',
    );
    expect(await stockOf(f.last)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('the same customer checking out twice at once gets one order', async () => {
    const c = await customer();
    await add(c, { variantId: f.six });
    const results = await Promise.all([
      checkout(c, { paymentMethod: 'cod', address: PUNE }),
      checkout(c, { paymentMethod: 'cod', address: PUNE }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await prisma.order.count({ where: { customerId: c.userId } })).toBe(1);
  });
});

describe('discount usage limits', () => {
  it('a single-use code goes to the first order and comes back when it is cancelled', async () => {
    const [a, b] = [await customer(), await customer()];
    for (const c of [a, b]) {
      await add(c, { variantId: f.fifteen });
      await http(c, 'patch', '/v1/cart').send({ discountCode: f.limitedCode }).expect(200);
    }
    const order = await placed(a, { paymentMethod: 'cod', address: PUNE });
    expect(order.totals.discountPaise).toBe(5000);
    expect(await prisma.discountRedemption.count({ where: { discountId: f.discountIds[0] } })).toBe(
      1,
    );

    expectCode(
      await checkout(b, { paymentMethod: 'cod', address: PUNE }).expect(422),
      'DISCOUNT_NOT_APPLICABLE',
    );

    await http(a, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    expect(await prisma.discountRedemption.count({ where: { discountId: f.discountIds[0] } })).toBe(
      0,
    );
    const bOrder = await placed(b, { paymentMethod: 'cod', address: PUNE });
    expect(bOrder.totals.discountPaise).toBe(5000);
  });
});

describe('cancelling', () => {
  it('an unpaid prepaid order releases its reservation', async () => {
    const c = await customer();
    await add(c, { variantId: f.fifteen, quantity: 2 });
    const order = await placed(c, { paymentMethod: 'prepaid', address: PUNE });
    const held = await stockOf(f.fifteen);

    const res = await http(c, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    const cancelled = orderDetailSchema.parse(res.body);
    expect(cancelled).toMatchObject({ status: 'cancelled', canCancel: false, payBy: null });
    expect(cancelled.timeline.map((t) => t.status)).toEqual(['pending_payment', 'cancelled']);
    expect(await stockOf(f.fifteen)).toEqual({
      stock: held.stock,
      reservedStock: held.reservedStock - 2,
    });
  });

  it('a confirmed COD order puts the stock back', async () => {
    const c = await customer();
    await add(c, { variantId: f.six, quantity: 3 });
    const before = await stockOf(f.six);
    const order = await placed(c, { paymentMethod: 'cod', address: PUNE });
    await http(c, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    expect(await stockOf(f.six)).toEqual(before);
    const row = await orderRow(order.number);
    expect(row.events.at(-1)).toMatchObject({
      fromStatus: 'confirmed',
      toStatus: 'cancelled',
      actor: 'customer',
    });
  });

  it('refuses after dispatch', async () => {
    const c = await customer();
    const orders = app.get(OrdersService);
    await add(c, { variantId: f.six });
    const cod = await placed(c, { paymentMethod: 'cod', address: PUNE });
    const codId = (await orderRow(cod.number)).id;
    await prisma.$transaction(async (tx) => {
      await orders.transition(tx, codId, 'packed', { actor: 'admin' });
      await orders.transition(tx, codId, 'shipped', { actor: 'admin' });
    });
    expectCode(
      await http(c, 'post', `/v1/orders/${cod.number}/cancel`).expect(409),
      'ORDER_NOT_CANCELLABLE',
    );
    // Paid prepaid cancellation (with refund) is covered in payments.db-spec.ts.
  });

  it("can't see or cancel another customer's order", async () => {
    const [owner, other] = [await customer(), await customer()];
    await add(owner, { variantId: f.six });
    const order = await placed(owner, { paymentMethod: 'cod', address: PUNE });
    expectCode(await http(other, 'get', `/v1/orders/${order.number}`).expect(404), 'NOT_FOUND');
    expectCode(
      await http(other, 'post', `/v1/orders/${order.number}/cancel`).expect(404),
      'NOT_FOUND',
    );
  });
});

describe('reservation expiry', () => {
  it('cancels unpaid orders past their time and releases the stock', async () => {
    const c = await customer();
    await add(c, { variantId: f.fifteen });
    const order = await placed(c, { paymentMethod: 'prepaid', address: PUNE });
    const held = await stockOf(f.fifteen);
    await prisma.order.update({
      where: { number: order.number },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });

    expect(await app.get(OrdersService).expireReservations()).toBeGreaterThanOrEqual(1);
    const row = await orderRow(order.number);
    expect(row.status).toBe('cancelled');
    expect(row.events.at(-1)).toMatchObject({ toStatus: 'cancelled', actor: 'system' });
    expect(await stockOf(f.fifteen)).toEqual({
      stock: held.stock,
      reservedStock: held.reservedStock - 1,
    });
  });

  it('leaves orders that are still within their time', async () => {
    const c = await customer();
    await add(c, { variantId: f.fifteen });
    const order = await placed(c, { paymentMethod: 'prepaid', address: PUNE });
    await app.get(OrdersService).expireReservations();
    expect((await orderRow(order.number)).status).toBe('pending_payment');
  });
});

describe('order history', () => {
  it('lists newest first with cursor paging', async () => {
    const c = await customer();
    const numbers: string[] = [];
    for (let i = 0; i < 2; i++) {
      await add(c, { variantId: f.six });
      numbers.push((await placed(c, { paymentMethod: 'cod', address: PUNE })).number);
    }
    const page = paginated(orderSummarySchema);
    const first = page.parse((await http(c, 'get', '/v1/orders?limit=1').expect(200)).body);
    expect(first.data.map((o) => o.number)).toEqual([numbers[1]]);
    expect(first.data[0]).toMatchObject({
      itemCount: 1,
      firstItemName: 'Test latte',
      status: 'confirmed',
    });
    const second = page.parse(
      (await http(c, 'get', `/v1/orders?limit=1&cursor=${first.nextCursor}`).expect(200)).body,
    );
    expect(second.data.map((o) => o.number)).toEqual([numbers[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it('validates order numbers', async () => {
    expectCode(
      await http(await customer(), 'get', '/v1/orders/not-a-number').expect(400),
      'VALIDATION_FAILED',
    );
  });
});
