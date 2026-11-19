import { productDetailSchema } from '@brand/shared';
import { describe, expect, it } from 'vitest';
import {
  CatalogMapper,
  isAvailable,
  mediaUrl,
  type ProductRow,
  type VariantRow,
} from './catalog.mapper.js';

function variant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: 'v1',
    sku: 'HAZ-06',
    name: '6 sachets',
    packSize: 6,
    mrpPaise: 34900,
    pricePaise: 29900,
    stock: 10,
    reservedStock: 0,
    ...overrides,
  };
}

function product(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'p1',
    slug: 'hazel-almond-latte',
    name: 'Hazel Almond Latte',
    description: 'desc',
    type: 'coffee',
    onePerCustomer: false,
    variants: [variant()],
    media: [],
    ...overrides,
  };
}

const mapper = new CatalogMapper('https://cdn.example.com/');

describe('isAvailable', () => {
  it('subtracts stock held by unpaid orders', () => {
    expect(isAvailable({ stock: 5, reservedStock: 4 })).toBe(true);
    expect(isAvailable({ stock: 5, reservedStock: 5 })).toBe(false);
    expect(isAvailable({ stock: 0, reservedStock: 0 })).toBe(false);
  });
});

describe('mediaUrl', () => {
  it('joins without doubled slashes', () => {
    expect(mediaUrl('https://cdn.example.com/', '/products/a.jpg')).toBe(
      'https://cdn.example.com/products/a.jpg',
    );
    expect(mediaUrl('/media', 'a.jpg')).toBe('/media/a.jpg');
  });
});

describe('CatalogMapper.productSummary', () => {
  it('uses the cheapest variant for both from-price and from-MRP', () => {
    const summary = mapper.productSummary(
      product({
        variants: [
          variant({ id: 'big', pricePaise: 69900, mrpPaise: 79900 }),
          variant({ id: 'small', pricePaise: 29900, mrpPaise: 34900 }),
        ],
      }),
    );
    expect(summary.fromPricePaise).toBe(29900);
    expect(summary.fromMrpPaise).toBe(34900);
  });

  it('is in stock if any variant is', () => {
    const outOfStock = variant({ stock: 3, reservedStock: 3 });
    expect(mapper.productSummary(product({ variants: [outOfStock] })).inStock).toBe(false);
    expect(mapper.productSummary(product({ variants: [outOfStock, variant()] })).inStock).toBe(
      true,
    );
  });

  it('uses the first media item as the image', () => {
    const summary = mapper.productSummary(
      product({
        media: [
          { storageKey: 'p/1.jpg', alt: 'Front' },
          { storageKey: 'p/2.jpg', alt: 'Back' },
        ],
      }),
    );
    expect(summary.image).toEqual({ url: 'https://cdn.example.com/p/1.jpg', alt: 'Front' });
    expect(mapper.productSummary(product()).image).toBeNull();
  });
});

describe('CatalogMapper.productDetail', () => {
  it('never exposes stock counts, HSN codes or GST rates', () => {
    const row = product() as ProductRow & Record<string, unknown>;
    (row.variants[0] as VariantRow & Record<string, unknown>).hsnCode = '2101';
    (row.variants[0] as VariantRow & Record<string, unknown>).gstRateBps = 500;
    const detail = mapper.productDetail(row);

    expect(productDetailSchema.parse(detail)).toEqual(detail);
    const json = JSON.stringify(detail);
    for (const secret of ['stock', 'reservedStock', 'hsn', 'gst', '2101']) {
      expect(json).not.toContain(secret);
    }
    expect(detail.variants[0]).toHaveProperty('inStock', true);
  });
});

describe('CatalogMapper.bundleDetail', () => {
  it('is in stock while at least one option is', () => {
    const bundle = {
      id: 'b1',
      slug: 'bundle-of-2',
      sku: 'BUNDLE-2X15',
      name: 'Bundle of 2',
      description: null,
      slots: 2,
      mrpPaise: 159800,
      pricePaise: 129900,
    };
    const option = (stock: number) => ({
      variant: { ...variant({ stock }), product: { slug: 's', name: 'n', media: [] } },
    });
    expect(mapper.bundleDetail(bundle, [option(0), option(1)]).inStock).toBe(true);
    expect(mapper.bundleDetail(bundle, [option(0), option(0)]).inStock).toBe(false);
  });
});
