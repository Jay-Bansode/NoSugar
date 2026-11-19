/**
 * Cart over HTTP against real Postgres + Redis: guest carts, merge at login, item rules,
 * discount codes and line issues. Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Cart, cartSchema, errorResponseSchema } from '@brand/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';

const run = randomUUID().slice(0, 8).toUpperCase();
let app: NestExpressApplication;
let prisma: PrismaService;

const f = {
  productIds: [] as string[],
  userIds: [] as string[],
  orderIds: [] as string[],
  discountIds: [] as string[],
  /** Every cart id seen in a response, so guest carts are cleaned up too. */
  cartIds: new Set<string>(),
  bundleId: '',
  six: '',
  fifteen: '',
  retired: '',
  trial: '',
  trialProduct: '',
  code: `T${run}OFF50`,
  minCode: `T${run}BIG`,
};

const ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

interface Client {
  cartId?: string;
  token?: string;
  ip: string;
}

function guest(): Client {
  return { ip: ip() };
}

async function customer(): Promise<Client> {
  const user = await prisma.user.create({
    data: { phone: `+9198${randomInt(10_000_000, 99_999_999)}` },
  });
  f.userIds.push(user.id);
  const { token } = await app
    .get(TokenService)
    .signAccessToken({ userId: user.id, sessionId: randomUUID() });
  return { token, ip: ip(), cartId: undefined, ...{ userId: user.id } } as Client & {
    userId: string;
  };
}

function call(client: Client, method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  let req = request(app.getHttpServer())[method](path).set('X-Forwarded-For', client.ip);
  if (client.cartId) req = req.set('X-Cart-Id', client.cartId);
  if (client.token) req = req.set('Authorization', `Bearer ${client.token}`);
  return req;
}

/** Calls and parses a cart response, remembering the cart id like a real client would. */
async function cartCall(
  client: Client,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: object,
  status = 200,
): Promise<Cart> {
  const res = await call(client, method, path)
    .send(body ?? {})
    .expect(status);
  const cart = cartSchema.parse(res.body);
  if (cart.id) f.cartIds.add(cart.id);
  if (cart.id && !client.token) client.cartId = cart.id;
  return cart;
}

async function expectError(
  client: Client,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body: object | undefined,
  status: number,
  code: string,
) {
  const res = await call(client, method, path)
    .send(body ?? {})
    .expect(status);
  expect(errorResponseSchema.parse(res.body).error.code).toBe(code);
  return res.body.error as { message: string; details: Record<string, unknown> };
}

const lineFor = (cart: Cart, variantId: string) =>
  cart.lines.find((l) => l.variantId === variantId);

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

  const v = (name: string, price: number, packSize: number, stock: number, isActive = true) => ({
    sku: `T-${run}-${name}`,
    name,
    packSize,
    mrpPaise: price,
    pricePaise: price,
    hsnCode: '2101',
    gstRateBps: 500,
    stock,
    weightG: 100,
    isActive,
  });
  const coffee = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-latte`,
      name: 'Test latte',
      type: 'coffee',
      variants: {
        create: [
          v('SIX', 29900, 6, 5),
          v('FIFTEEN', 69900, 15, 10),
          v('RETIRED', 100, 6, 10, false),
        ],
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
      variants: { create: [v('TRIAL', 39900, 5, 10)] },
    },
    include: { variants: true },
  });
  f.productIds.push(coffee.id, trial.id);
  const id = (name: string) => coffee.variants.find((x) => x.name === name)!.id;
  f.six = id('SIX');
  f.fifteen = id('FIFTEEN');
  f.retired = id('RETIRED');
  f.trial = trial.variants[0]!.id;
  f.trialProduct = trial.id;

  const bundle = await prisma.bundle.create({
    data: {
      slug: `t-${run.toLowerCase()}-duo`,
      sku: `T-${run}-DUO`,
      name: 'Duo',
      slots: 2,
      mrpPaise: 99900,
      pricePaise: 79900,
      hsnCode: '2101',
      gstRateBps: 500,
      items: { create: [{ variantId: f.six }, { variantId: f.fifteen }] },
    },
  });
  f.bundleId = bundle.id;

  const d1 = await prisma.discount.create({
    data: { code: f.code, type: 'fixed', valuePaise: 5000 },
  });
  const d2 = await prisma.discount.create({
    data: { code: f.minCode, type: 'fixed', valuePaise: 5000, minSubtotalPaise: 200000 },
  });
  f.discountIds.push(d1.id, d2.id);
});

afterAll(async () => {
  // Items cascade with their carts.
  await prisma.cart.deleteMany({ where: { id: { in: [...f.cartIds] } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: f.orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: f.orderIds } } });
  await prisma.cart.deleteMany({ where: { userId: { in: f.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await prisma.discount.deleteMany({ where: { id: { in: f.discountIds } } });
  await prisma.bundle.deleteMany({ where: { id: f.bundleId } });
  await prisma.variant.deleteMany({ where: { productId: { in: f.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: f.productIds } } });
  await app.close();
});

describe('guest cart', () => {
  it('starts empty without creating anything', async () => {
    const cart = await cartCall(guest(), 'get', '/v1/cart');
    expect(cart).toMatchObject({ id: null, isGuest: true, lines: [], totals: null });
  });

  it('is created by the first item and found again by X-Cart-Id', async () => {
    const client = guest();
    const added = await cartCall(client, 'post', '/v1/cart/items', { variantId: f.six });
    expect(added.id).toBeTruthy();
    expect(added.totals).toMatchObject({
      subtotalPaise: 29900,
      shippingPaise: 9900,
      totalPaise: 39800,
    });

    const again = await cartCall(client, 'post', '/v1/cart/items', {
      variantId: f.six,
      quantity: 2,
    });
    expect(again.id).toBe(added.id);
    expect(again.lines).toHaveLength(1);
    expect(lineFor(again, f.six)!.quantity).toBe(3);

    const fetched = await cartCall(client, 'get', '/v1/cart');
    expect(fetched.lines[0]).toMatchObject({ variantId: f.six, quantity: 3, issue: null });
  });

  it('rejects unknown and malformed cart ids with CART_NOT_FOUND', async () => {
    await expectError(
      { ip: ip(), cartId: randomUUID() },
      'get',
      '/v1/cart',
      undefined,
      404,
      'CART_NOT_FOUND',
    );
    await expectError(
      { ip: ip(), cartId: 'nope' },
      'get',
      '/v1/cart',
      undefined,
      404,
      'CART_NOT_FOUND',
    );
  });

  it('cannot open a customer cart by its id', async () => {
    const owner = await customer();
    const cart = await cartCall(owner, 'post', '/v1/cart/items', { variantId: f.six });
    await expectError(
      { ip: ip(), cartId: cart.id! },
      'get',
      '/v1/cart',
      undefined,
      404,
      'CART_NOT_FOUND',
    );
  });

  it('treats an invalid token as 401, not as a guest', async () => {
    await expectError(
      { ip: ip(), token: 'a.b.c' },
      'get',
      '/v1/cart',
      undefined,
      401,
      'UNAUTHORIZED',
    );
  });
});

describe('items', () => {
  it('treats the same bundle picks in any order as one line', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', {
      bundleId: f.bundleId,
      selection: [f.six, f.fifteen],
    });
    const cart = await cartCall(client, 'post', '/v1/cart/items', {
      bundleId: f.bundleId,
      selection: [f.fifteen, f.six],
    });
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ kind: 'bundle', quantity: 2, name: 'Duo' });
    expect(cart.totals!.subtotalPaise).toBe(159800);
  });

  it('rejects an invalid bundle selection', async () => {
    await expectError(
      guest(),
      'post',
      '/v1/cart/items',
      { bundleId: f.bundleId, selection: [f.six] },
      422,
      'ITEM_UNAVAILABLE',
    );
  });

  it('rejects inactive items', async () => {
    await expectError(
      guest(),
      'post',
      '/v1/cart/items',
      { variantId: f.retired },
      422,
      'ITEM_UNAVAILABLE',
    );
  });

  it('checks stock across the whole cart without revealing the count', async () => {
    const client = guest();
    const err = await expectError(
      client,
      'post',
      '/v1/cart/items',
      { variantId: f.six, quantity: 6 },
      409,
      'OUT_OF_STOCK',
    );
    expect(err.message).not.toMatch(/\d/);

    // 4 six-packs + a bundle that also uses a six-pack ×2 = 6 > 5 in stock.
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.six, quantity: 4 });
    await expectError(
      client,
      'post',
      '/v1/cart/items',
      { bundleId: f.bundleId, selection: [f.six, f.fifteen], quantity: 2 },
      409,
      'OUT_OF_STOCK',
    );
  });

  it("updates and removes lines; other carts' lines are not found", async () => {
    const client = guest();
    const cart = await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    const lineId = cart.lines[0]!.id;
    const updated = await cartCall(client, 'patch', `/v1/cart/items/${lineId}`, { quantity: 3 });
    expect(updated.lines[0]!.quantity).toBe(3);

    await expectError(
      guest(),
      'patch',
      `/v1/cart/items/${lineId}`,
      { quantity: 1 },
      404,
      'CART_NOT_FOUND',
    );
    const other = guest();
    await cartCall(other, 'post', '/v1/cart/items', { variantId: f.six });
    await expectError(other, 'delete', `/v1/cart/items/${lineId}`, undefined, 404, 'NOT_FOUND');

    const removed = await cartCall(client, 'delete', `/v1/cart/items/${lineId}`);
    expect(removed.lines).toEqual([]);
    expect(removed.totals).toBeNull();
  });

  it('does not create duplicate lines under concurrent adds', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    await Promise.all(
      Array.from({ length: 4 }, () =>
        call(client, 'post', '/v1/cart/items').send({ variantId: f.six }).expect(200),
      ),
    );
    const cart = await cartCall(client, 'get', '/v1/cart');
    expect(lineFor(cart, f.six)!.quantity).toBe(4);
    expect(cart.lines).toHaveLength(2);
  });
});

describe('trial kit (one per customer)', () => {
  it('allows only one in the cart', async () => {
    const client = guest();
    await expectError(
      client,
      'post',
      '/v1/cart/items',
      { variantId: f.trial, quantity: 2 },
      409,
      'PURCHASE_LIMIT',
    );
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.trial });
    await expectError(
      client,
      'post',
      '/v1/cart/items',
      { variantId: f.trial },
      409,
      'PURCHASE_LIMIT',
    );
  });

  it('is refused for a customer who already ordered one', async () => {
    const client = (await customer()) as Client & { userId: string };
    const order = await prisma.order.create({
      data: {
        number: `T-${randomUUID().slice(0, 12)}`,
        customerId: client.userId,
        status: 'delivered',
        paymentMethod: 'prepaid',
        subtotalPaise: 39900,
        taxPaise: 6086,
        totalPaise: 39900,
        shippingAddress: {},
        idempotencyKey: randomUUID(),
        items: {
          create: {
            variantId: f.trial,
            productName: 'Test trial kit',
            variantName: 'TRIAL',
            sku: `T-${run}-TRIAL`,
            hsnCode: '2101',
            gstRateBps: 500,
            unitPricePaise: 39900,
            quantity: 1,
            lineTotalPaise: 39900,
            taxPaise: 1900,
          },
        },
      },
    });
    f.orderIds.push(order.id);
    await expectError(
      client,
      'post',
      '/v1/cart/items',
      { variantId: f.trial },
      409,
      'PURCHASE_LIMIT',
    );
  });
});

describe('discount codes', () => {
  it('applies a valid code, rejects an invalid one without saving it, and can be removed', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    const withCode = await cartCall(client, 'patch', '/v1/cart', {
      discountCode: f.code.toLowerCase(),
    });
    expect(withCode.discountCode).toBe(f.code);
    expect(withCode.totals!.discountPaise).toBe(5000);

    await expectError(
      client,
      'patch',
      '/v1/cart',
      { discountCode: 'NOPE-NOPE' },
      422,
      'DISCOUNT_INVALID',
    );
    expect((await cartCall(client, 'get', '/v1/cart')).discountCode).toBe(f.code);

    const removed = await cartCall(client, 'patch', '/v1/cart', { discountCode: null });
    expect(removed.discountCode).toBeNull();
    expect(removed.totals!.discountPaise).toBe(0);
  });

  it('keeps a code below its minimum and says how much more to add', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    const cart = await cartCall(client, 'patch', '/v1/cart', { discountCode: f.minCode });
    expect(cart.totals!.discountPaise).toBe(0);
    expect(cart.discountMessage).toBe(`Add ₹1,301 more to use ${f.minCode}.`);
  });
});

describe('line issues and totals', () => {
  it('flags unavailable and out-of-stock lines and leaves them out of the totals', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.six });
    await prisma.variant.update({ where: { id: f.six }, data: { isActive: false } });
    try {
      const cart = await cartCall(client, 'get', '/v1/cart');
      expect(lineFor(cart, f.six)).toMatchObject({ issue: 'UNAVAILABLE', lineTotalPaise: null });
      expect(cart.totals!.subtotalPaise).toBe(69900);
    } finally {
      await prisma.variant.update({ where: { id: f.six }, data: { isActive: true } });
    }

    await prisma.variant.update({ where: { id: f.fifteen }, data: { reservedStock: 10 } });
    try {
      const cart = await cartCall(client, 'get', '/v1/cart');
      expect(lineFor(cart, f.fifteen)!.issue).toBe('OUT_OF_STOCK');
      expect(cart.totals!.subtotalPaise).toBe(29900);
    } finally {
      await prisma.variant.update({ where: { id: f.fifteen }, data: { reservedStock: 0 } });
    }
  });

  it('previews the COD fee', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    const cod = await cartCall(client, 'get', '/v1/cart?paymentMethod=cod');
    expect(cod.paymentMethod).toBe('cod');
    expect(cod.totals!.codFeePaise).toBe(4900);
    expect(cod.totals!.totalPaise).toBe(69900 + 4900);
  });

  it('clears items and the discount code', async () => {
    const client = guest();
    await cartCall(client, 'post', '/v1/cart/items', { variantId: f.fifteen });
    await cartCall(client, 'patch', '/v1/cart', { discountCode: f.code });
    const cleared = await cartCall(client, 'delete', '/v1/cart');
    expect(cleared).toMatchObject({ lines: [], discountCode: null, totals: null });
  });
});

describe('merge at login', () => {
  it('merges the guest cart into the customer cart and deletes the guest cart', async () => {
    const shopper = guest();
    await cartCall(shopper, 'post', '/v1/cart/items', { variantId: f.six, quantity: 2 });
    await cartCall(shopper, 'post', '/v1/cart/items', { variantId: f.trial });
    await cartCall(shopper, 'patch', '/v1/cart', { discountCode: f.code });
    const guestCartId = shopper.cartId!;

    const account = await customer();
    await cartCall(account, 'post', '/v1/cart/items', { variantId: f.six });

    // After login the client still sends its guest cart id once.
    const merged = await cartCall({ ...account, cartId: guestCartId }, 'get', '/v1/cart');
    expect(merged.isGuest).toBe(false);
    expect(merged.id).not.toBe(guestCartId);
    expect(lineFor(merged, f.six)!.quantity).toBe(3);
    expect(lineFor(merged, f.trial)!.quantity).toBe(1);
    expect(merged.discountCode).toBe(f.code);

    expect(await prisma.cart.findUnique({ where: { id: guestCartId } })).toBeNull();
    await expectError(
      { ip: ip(), cartId: guestCartId },
      'get',
      '/v1/cart',
      undefined,
      404,
      'CART_NOT_FOUND',
    );

    // Sending the stale guest id again is harmless.
    const again = await cartCall({ ...account, cartId: guestCartId }, 'get', '/v1/cart');
    expect(lineFor(again, f.six)!.quantity).toBe(3);
  });
});
