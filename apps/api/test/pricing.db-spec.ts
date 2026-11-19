/**
 * PricingService against real Postgres: item resolution, discount validity and DB settings.
 * The arithmetic itself is covered by packages/shared/src/pricing.spec.ts.
 * Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { taxFromInclusive } from '@brand/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { PricingService, type QuoteRequest } from '../src/modules/pricing/pricing.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';

const run = randomUUID().slice(0, 8).toUpperCase();
const code = (name: string) => `T${run}${name}`;

let app: NestExpressApplication;
let prisma: PrismaService;
let pricing: PricingService;

const f = {} as {
  productIds: string[];
  six: string;
  fifteen: string;
  retired: string;
  trial: string;
  bundle: string;
  customer: string;
  otherCustomer: string;
  orderIds: string[];
  discountIds: string[];
  settingsBackup: { key: string; value: unknown }[];
};

const tax = { hsnCode: '2101', gstRateBps: 500 };

async function createProduct(
  name: string,
  type: 'coffee' | 'trial_kit',
  variants: {
    name: string;
    price: number;
    packSize: number | null;
    gst?: number;
    isActive?: boolean;
  }[],
) {
  const product = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-${name}`,
      name: `Test ${name}`,
      type,
      onePerCustomer: type === 'trial_kit',
      variants: {
        create: variants.map((v) => ({
          sku: `T-${run}-${name}-${v.name}`.toUpperCase(),
          name: v.name,
          packSize: v.packSize,
          mrpPaise: v.price,
          pricePaise: v.price,
          hsnCode: '2101',
          gstRateBps: v.gst ?? 500,
          stock: 10,
          weightG: 100,
          isActive: v.isActive ?? true,
        })),
      },
    },
    include: { variants: true },
  });
  f.productIds.push(product.id);
  return product;
}

async function createOrderFor(customerId: string): Promise<string> {
  const order = await prisma.order.create({
    data: {
      number: `T-${randomUUID().slice(0, 12)}`,
      customerId,
      status: 'confirmed',
      paymentMethod: 'prepaid',
      subtotalPaise: 29900,
      shippingPaise: 9900,
      taxPaise: 1424,
      totalPaise: 39800,
      shippingAddress: {},
      idempotencyKey: randomUUID(),
    },
  });
  f.orderIds.push(order.id);
  return order.id;
}

async function createDiscount(name: string, data: Record<string, unknown> = {}) {
  const discount = await prisma.discount.create({
    data: { code: code(name), type: 'percentage', valueBps: 1000, ...data },
  });
  f.discountIds.push(discount.id);
  return discount;
}

function quote(overrides: Partial<QuoteRequest> = {}) {
  return pricing.quote({
    items: [{ key: 'a', variantId: f.six, quantity: 1 }],
    paymentMethod: 'prepaid',
    ...overrides,
  });
}

async function expectAppError(promise: Promise<unknown>, errorCode: string) {
  const err = await promise.then(
    () => expect.unreachable(`expected ${errorCode}`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).code).toBe(errorCode);
  return err as AppException;
}

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
  prisma = app.get(PrismaService);
  pricing = app.get(PricingService);
  Object.assign(f, { productIds: [], orderIds: [], discountIds: [] });

  // Settings are shared rows: remember them so the tests can change and restore them.
  f.settingsBackup = (await prisma.setting.findMany()).map((s) => ({ key: s.key, value: s.value }));

  const coffee = await createProduct('latte', 'coffee', [
    { name: 'six', price: 29900, packSize: 6 },
    { name: 'fifteen', price: 69900, packSize: 15 },
    { name: 'retired', price: 100, packSize: 6, isActive: false },
  ]);
  const byName = (n: string) => coffee.variants.find((v) => v.name === n)!.id;
  f.six = byName('six');
  f.fifteen = byName('fifteen');
  f.retired = byName('retired');
  const trial = await createProduct('trial', 'trial_kit', [
    { name: 'kit', price: 39900, packSize: 5, gst: 1800 },
  ]);
  f.trial = trial.variants[0]!.id;

  const bundle = await prisma.bundle.create({
    data: {
      ...tax,
      slug: `t-${run.toLowerCase()}-duo`,
      sku: `T-${run}-DUO`,
      name: 'Duo',
      slots: 2,
      mrpPaise: 99900,
      pricePaise: 79900,
      items: { create: [{ variantId: f.six }, { variantId: f.fifteen }] },
    },
  });
  f.bundle = bundle.id;

  const phone = () => `+9199${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  f.customer = (await prisma.user.create({ data: { phone: phone() } })).id;
  f.otherCustomer = (await prisma.user.create({ data: { phone: phone() } })).id;
});

beforeEach(async () => {
  await restoreSettings();
});

async function restoreSettings() {
  await prisma.setting.deleteMany({});
  if (f.settingsBackup.length > 0) {
    await prisma.setting.createMany({
      data: f.settingsBackup.map((s) => ({ key: s.key, value: s.value as never })),
    });
  }
}

afterAll(async () => {
  await restoreSettings();
  await prisma.discountRedemption.deleteMany({ where: { discountId: { in: f.discountIds } } });
  await prisma.discount.deleteMany({ where: { id: { in: f.discountIds } } });
  await prisma.order.deleteMany({ where: { id: { in: f.orderIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [f.customer, f.otherCustomer] } } });
  await prisma.bundle.deleteMany({ where: { id: f.bundle } });
  await prisma.variant.deleteMany({ where: { productId: { in: f.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: f.productIds } } });
  await app.close();
});

describe('item resolution', () => {
  it('prices from current catalog values and keeps snapshot fields', async () => {
    const { quote: q, lines } = await quote({
      items: [
        { key: 'a', variantId: f.six, quantity: 2 },
        { key: 'b', variantId: f.fifteen, quantity: 1 },
      ],
    });
    expect(q.subtotalPaise).toBe(29900 * 2 + 69900);
    expect(q.shippingPaise).toBe(0);
    expect(q.taxPaise).toBe(taxFromInclusive(59800, 500) + taxFromInclusive(69900, 500));
    expect(q.totalPaise).toBe(129700);
    expect(lines[0]).toMatchObject({
      key: 'a',
      sku: `T-${run}-LATTE-SIX`,
      hsnCode: '2101',
      productName: 'Test latte',
      variantName: 'six',
    });
  });

  it('marks only standalone 15-packs wallet-eligible and the trial kit non-discountable', async () => {
    const { lines } = await quote({
      items: [
        { key: 'six', variantId: f.six, quantity: 1 },
        { key: 'fifteen', variantId: f.fifteen, quantity: 1 },
        { key: 'trial', variantId: f.trial, quantity: 1 },
        { key: 'bundle', bundleId: f.bundle, quantity: 1, selection: [f.fifteen, f.fifteen] },
      ],
    });
    const flags = Object.fromEntries(
      lines.map((l) => [l.key, [l.walletEligible, l.discountable, l.onePerCustomer]]),
    );
    expect(flags).toEqual({
      six: [false, true, false],
      fifteen: [true, true, false],
      trial: [false, false, true],
      bundle: [false, true, false],
    });
  });

  it('prices a bundle at the bundle price and allows repeated picks', async () => {
    const { quote: q, lines } = await quote({
      items: [{ key: 'b', bundleId: f.bundle, quantity: 1, selection: [f.six, f.six] }],
    });
    expect(q.subtotalPaise).toBe(79900);
    expect(lines[0]).toMatchObject({ sku: `T-${run}-DUO`, variantName: 'Test latte + Test latte' });
    expect(lines[0]!.selection).toEqual([f.six, f.six]);
  });

  it.each([
    ['too few picks', () => [f.six]],
    ['too many picks', () => [f.six, f.six, f.six]],
    ['a pack not in the bundle', () => [f.six, f.trial]],
    ['an inactive pack', () => [f.six, f.retired]],
  ])('rejects a bundle with %s', async (_label, selection) => {
    const err = await expectAppError(
      quote({ items: [{ key: 'b', bundleId: f.bundle, quantity: 1, selection: selection() }] }),
      'ITEM_UNAVAILABLE',
    );
    expect(err.details).toEqual({ key: 'b' });
  });

  it('rejects inactive or unknown variants, naming the line', async () => {
    const err = await expectAppError(
      quote({ items: [{ key: 'gone', variantId: f.retired, quantity: 1 }] }),
      'ITEM_UNAVAILABLE',
    );
    expect(err.details).toEqual({ key: 'gone' });
    await expectAppError(
      quote({ items: [{ key: 'x', variantId: randomUUID(), quantity: 1 }] }),
      'ITEM_UNAVAILABLE',
    );
  });

  it.each([0, 100, 1.5])('rejects quantity %s', async (quantity) => {
    await expectAppError(
      quote({ items: [{ key: 'a', variantId: f.six, quantity }] }),
      'ITEM_UNAVAILABLE',
    );
  });
});

describe('discount codes', () => {
  it('applies a valid code, ignoring case and spaces', async () => {
    const d = await createDiscount('PCT10');
    const { quote: q, discount } = await quote({ discountCode: `  ${d.code.toLowerCase()} ` });
    expect(q.discountPaise).toBe(2990);
    expect(discount).toEqual({ id: d.id, code: d.code });
  });

  it.each([
    ['unknown', async () => code('NOPE')],
    ['inactive', async () => (await createDiscount('OFF', { isActive: false })).code],
    [
      'expired',
      async () => (await createDiscount('OLD', { endsAt: new Date(Date.now() - 1000) })).code,
    ],
    [
      'not started',
      async () =>
        (await createDiscount('SOON', { startsAt: new Date(Date.now() + 3_600_000) })).code,
    ],
  ])('rejects %s codes with DISCOUNT_INVALID', async (_label, makeCode) => {
    await expectAppError(quote({ discountCode: await makeCode() }), 'DISCOUNT_INVALID');
  });

  it('stops a code once its total usage limit is reached', async () => {
    const d = await createDiscount('LIMIT1', { usageLimit: 1 });
    await quote({ discountCode: d.code }); // still available
    await prisma.discountRedemption.create({
      data: {
        discountId: d.id,
        orderId: await createOrderFor(f.otherCustomer),
        customerId: f.otherCustomer,
        amountPaise: 100,
      },
    });
    await expectAppError(quote({ discountCode: d.code }), 'DISCOUNT_NOT_APPLICABLE');
  });

  it('enforces the per-customer limit for that customer only', async () => {
    const d = await createDiscount('ONCE', { perCustomerLimit: 1 });
    await prisma.discountRedemption.create({
      data: {
        discountId: d.id,
        orderId: await createOrderFor(f.customer),
        customerId: f.customer,
        amountPaise: 100,
      },
    });
    await expectAppError(
      quote({ discountCode: d.code, customerId: f.customer }),
      'DISCOUNT_NOT_APPLICABLE',
    );
    await expect(
      quote({ discountCode: d.code, customerId: f.otherCustomer }),
    ).resolves.toBeTruthy();
    // Guests can't be checked yet; checkout (which requires login) checks again.
    await expect(quote({ discountCode: d.code })).resolves.toBeTruthy();
  });

  it('reports a code below its minimum order instead of applying it', async () => {
    const d = await createDiscount('MIN', {
      type: 'fixed',
      valueBps: null,
      valuePaise: 5000,
      minSubtotalPaise: 100000,
    });
    const { quote: q, discount } = await quote({ discountCode: d.code });
    expect(q.discountBelowMinimum).toBe(true);
    expect(q.discountPaise).toBe(0);
    expect(discount).toBeNull();
  });
});

describe('settings', () => {
  async function setSetting(key: string, value: unknown) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });
  }

  it('uses fees from the settings table', async () => {
    await setSetting('shipping.flat_fee_paise', 4900);
    await setSetting('shipping.free_threshold_paise', 100000);
    const { quote: q } = await quote({ items: [{ key: 'a', variantId: f.fifteen, quantity: 1 }] });
    expect(q.shippingPaise).toBe(4900);
    expect(q.amountToFreeShippingPaise).toBe(100000 - 69900);
  });

  it('falls back to the default when a stored value is invalid', async () => {
    await setSetting('shipping.flat_fee_paise', 'ninety-nine');
    const { quote: q } = await quote();
    expect(q.shippingPaise).toBe(9900);
  });

  it('refuses COD when it is switched off', async () => {
    await setSetting('cod.enabled', false);
    await expectAppError(quote({ paymentMethod: 'cod' }), 'COD_UNAVAILABLE');
  });

  it('adds the COD fee from settings', async () => {
    await setSetting('cod.fee_paise', 2900);
    const { quote: q } = await quote({ paymentMethod: 'cod' });
    expect(q.codFeePaise).toBe(2900);
  });
});
