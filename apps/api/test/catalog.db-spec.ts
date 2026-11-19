/**
 * Public catalog endpoints against real Postgres, using fixtures created (and removed) here.
 * Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  bundleDetailSchema,
  bundleSummarySchema,
  collectionSchema,
  errorResponseSchema,
  paginated,
  productDetailSchema,
  productSummarySchema,
} from '@brand/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';

const run = randomUUID().slice(0, 8);
const slug = (name: string) => `t-${run}-${name}`;
const sku = (name: string) => `T-${run}-${name}`.toUpperCase();

let app: NestExpressApplication;
let prisma: PrismaService;
const ids = { products: [] as string[], bundles: [] as string[], collections: [] as string[] };

function get(path: string) {
  return request(app.getHttpServer()).get(path);
}

const taxBase = { hsnCode: '2101', gstRateBps: 500 };
const variantBase = { ...taxBase, weightG: 150 };

async function createProduct(
  name: string,
  data: { type?: 'coffee' | 'merchandise'; isActive?: boolean },
  variants: {
    name: string;
    price: number;
    position?: number;
    stock?: number;
    isActive?: boolean;
  }[],
) {
  const product = await prisma.product.create({
    data: {
      slug: slug(name),
      name: `Test ${name}`,
      type: data.type ?? 'coffee',
      isActive: data.isActive ?? true,
      variants: {
        create: variants.map((v) => ({
          ...variantBase,
          sku: sku(`${name}-${v.name}`),
          name: v.name,
          packSize: 6,
          mrpPaise: v.price + 5000,
          pricePaise: v.price,
          stock: v.stock ?? 10,
          position: v.position ?? 0,
          isActive: v.isActive ?? true,
        })),
      },
    },
    include: { variants: true },
  });
  ids.products.push(product.id);
  return product;
}

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    CDN_BASE_URL: 'https://cdn.test/',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
  await app.init();
  prisma = app.get(PrismaService);

  const latte = await createProduct('latte', {}, [
    { name: '15 sachets', price: 69900, position: 1, stock: 0 },
    { name: '6 sachets', price: 29900, position: 0, stock: 5 },
    { name: 'retired', price: 100, position: 2, isActive: false },
  ]);
  await prisma.productMedia.createMany({
    data: [
      { productId: latte.id, storageKey: `products/${run}/back.jpg`, alt: 'Back', position: 1 },
      { productId: latte.id, storageKey: `products/${run}/front.jpg`, alt: 'Front', position: 0 },
    ],
  });
  const mug = await createProduct('mug', { type: 'merchandise' }, [{ name: 'Mug', price: 49900 }]);
  const hidden = await createProduct('hidden', { isActive: false }, [{ name: 'x', price: 1000 }]);
  await createProduct('no-variants', {}, [{ name: 'x', price: 1000, isActive: false }]);

  const collection = await prisma.collection.create({
    data: {
      slug: slug('picks'),
      name: 'Picks',
      items: {
        create: [
          { productId: latte.id, position: 2 },
          { productId: hidden.id, position: 1 },
          { productId: mug.id, position: 0 },
        ],
      },
    },
  });
  ids.collections.push(collection.id);

  const retired = latte.variants.find((v) => v.name === 'retired')!;
  const sixPack = latte.variants.find((v) => v.name === '6 sachets')!;
  const bundle = await prisma.bundle.create({
    data: {
      ...taxBase,
      slug: slug('duo'),
      sku: sku('duo'),
      name: 'Duo',
      slots: 2,
      mrpPaise: 99900,
      pricePaise: 79900,
      items: {
        create: [
          { variantId: sixPack.id },
          { variantId: mug.variants[0]!.id },
          { variantId: retired.id },
        ],
      },
    },
  });
  const inactiveBundle = await prisma.bundle.create({
    data: {
      ...taxBase,
      slug: slug('old-duo'),
      sku: sku('old-duo'),
      name: 'Old duo',
      slots: 2,
      mrpPaise: 99900,
      pricePaise: 79900,
      isActive: false,
      items: { create: [{ variantId: sixPack.id }] },
    },
  });
  ids.bundles.push(bundle.id, inactiveBundle.id);
});

afterAll(async () => {
  await prisma.bundle.deleteMany({ where: { id: { in: ids.bundles } } });
  await prisma.collection.deleteMany({ where: { id: { in: ids.collections } } });
  await prisma.variant.deleteMany({ where: { productId: { in: ids.products } } });
  await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
  await app.close();
});

const productPage = paginated(productSummarySchema);

describe('GET /v1/products', () => {
  it('is public, cacheable, and pages through every listable product exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/v1/products?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      expect(res.headers['cache-control']).toContain('public');
      const page = productPage.parse(res.body);
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data.map((p) => p.slug));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 100);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([slug('latte'), slug('mug')]));
    expect(seen).not.toContain(slug('hidden'));
    expect(seen).not.toContain(slug('no-variants'));

    const listable = await prisma.product.count({
      where: { isActive: true, variants: { some: { isActive: true } } },
    });
    expect(seen).toHaveLength(listable);
  });

  it('filters by type', async () => {
    const res = await get('/v1/products?type=merchandise&limit=100').expect(200);
    const slugs = productPage.parse(res.body).data.map((p) => p.slug);
    expect(slugs).toContain(slug('mug'));
    expect(slugs).not.toContain(slug('latte'));
  });

  it('summarises price from the cheapest active variant, with the first image', async () => {
    const res = await get('/v1/products?type=coffee&limit=100').expect(200);
    const latte = productPage.parse(res.body).data.find((p) => p.slug === slug('latte'));
    expect(latte).toMatchObject({
      fromPricePaise: 29900, // the inactive â‚¹1 variant is ignored
      fromMrpPaise: 34900,
      inStock: true,
      image: { url: `https://cdn.test/products/${run}/front.jpg`, alt: 'Front' },
    });
  });

  it.each(['cursor=not-a-uuid', 'limit=101', 'limit=0', 'type=tea'])(
    'rejects ?%s with VALIDATION_FAILED',
    async (qs) => {
      const res = await get(`/v1/products?${qs}`).expect(400);
      expect(errorResponseSchema.parse(res.body).error.code).toBe('VALIDATION_FAILED');
    },
  );
});

describe('GET /v1/products/:slug', () => {
  it('returns active variants in position order with stock as a flag only', async () => {
    const res = await get(`/v1/products/${slug('latte')}`).expect(200);
    const product = productDetailSchema.parse(res.body);
    expect(product.variants.map((v) => [v.name, v.pricePaise, v.inStock])).toEqual([
      ['6 sachets', 29900, true],
      ['15 sachets', 69900, false],
    ]);
    expect(product.media.map((m) => m.alt)).toEqual(['Front', 'Back']);

    const raw = JSON.stringify(res.body);
    for (const field of ['stock', 'reserved', 'hsn', 'gst', 'weight']) {
      expect(raw.toLowerCase()).not.toContain(field.toLowerCase() === 'stock' ? '"stock"' : field);
    }
  });

  it.each(['hidden', 'no-variants', 'missing'])('404s for %s products', async (name) => {
    const res = await get(`/v1/products/${slug(name)}`).expect(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed slugs', async () => {
    await get('/v1/products/Bad_Slug').expect(400);
  });
});

describe('GET /v1/collections/:slug', () => {
  it('lists active products in position order', async () => {
    const res = await get(`/v1/collections/${slug('picks')}`).expect(200);
    const collection = collectionSchema.parse(res.body);
    expect(collection.products.map((p) => p.slug)).toEqual([slug('mug'), slug('latte')]);
  });

  it('404s for unknown collections', async () => {
    await get(`/v1/collections/${slug('nope')}`).expect(404);
  });
});

describe('bundles', () => {
  it('lists active bundles only', async () => {
    const res = await get('/v1/bundles').expect(200);
    const slugs = z
      .array(bundleSummarySchema)
      .parse(res.body)
      .map((b) => b.slug);
    expect(slugs).toContain(slug('duo'));
    expect(slugs).not.toContain(slug('old-duo'));
  });

  it('shows only active options to pick from', async () => {
    const res = await get(`/v1/bundles/${slug('duo')}`).expect(200);
    const bundle = bundleDetailSchema.parse(res.body);
    expect(bundle.slots).toBe(2);
    expect(bundle.inStock).toBe(true);
    expect(bundle.options.map((o) => o.variantName).sort()).toEqual(['6 sachets', 'Mug']);
  });

  it('404s for inactive bundles', async () => {
    await get(`/v1/bundles/${slug('old-duo')}`).expect(404);
  });
});
