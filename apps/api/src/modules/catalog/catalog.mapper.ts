import type {
  BundleDetail,
  BundleOption,
  BundleSummary,
  Media,
  ProductDetail,
  ProductSummary,
  ProductType,
  Variant,
} from '@brand/shared';

/**
 * Pure mapping from database rows to public API shapes. This is the one place that decides
 * what the storefront may see: no stock counts, HSN codes or GST rates leave the API.
 */

export interface VariantRow {
  id: string;
  sku: string;
  name: string;
  packSize: number | null;
  mrpPaise: number;
  pricePaise: number;
  stock: number;
  reservedStock: number;
}

export interface MediaRow {
  storageKey: string;
  alt: string;
}

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: ProductType;
  onePerCustomer: boolean;
  variants: VariantRow[];
  media: MediaRow[];
}

export interface BundleRow {
  id: string;
  slug: string;
  sku: string;
  name: string;
  description: string | null;
  slots: number;
  mrpPaise: number;
  pricePaise: number;
}

export interface BundleOptionRow {
  variant: VariantRow & { product: Pick<ProductRow, 'slug' | 'name' | 'media'> };
}

/** Sellable now: stock not already held by unpaid orders. */
export function isAvailable(variant: Pick<VariantRow, 'stock' | 'reservedStock'>): boolean {
  return variant.stock - variant.reservedStock > 0;
}

export function mediaUrl(baseUrl: string, storageKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${storageKey.replace(/^\/+/, '')}`;
}

export class CatalogMapper {
  constructor(private readonly mediaBaseUrl: string) {}

  media(row: MediaRow): Media {
    return { url: mediaUrl(this.mediaBaseUrl, row.storageKey), alt: row.alt };
  }

  variant(row: VariantRow): Variant {
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      packSize: row.packSize,
      mrpPaise: row.mrpPaise,
      pricePaise: row.pricePaise,
      inStock: isAvailable(row),
    };
  }

  /** `row.variants` must be the active variants only and non-empty. */
  productSummary(row: ProductRow): ProductSummary {
    const cheapest = row.variants.reduce((min, v) => (v.pricePaise < min.pricePaise ? v : min));
    const firstMedia = row.media[0];
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      onePerCustomer: row.onePerCustomer,
      fromPricePaise: cheapest.pricePaise,
      // MRP of the same variant, so "from" price and strike-through price always match.
      fromMrpPaise: cheapest.mrpPaise,
      inStock: row.variants.some(isAvailable),
      image: firstMedia ? this.media(firstMedia) : null,
    };
  }

  productDetail(row: ProductRow): ProductDetail {
    return {
      ...this.productSummary(row),
      description: row.description,
      variants: row.variants.map((v) => this.variant(v)),
      media: row.media.map((m) => this.media(m)),
    };
  }

  bundleSummary(row: BundleRow): BundleSummary {
    return {
      id: row.id,
      slug: row.slug,
      sku: row.sku,
      name: row.name,
      description: row.description,
      slots: row.slots,
      mrpPaise: row.mrpPaise,
      pricePaise: row.pricePaise,
    };
  }

  bundleDetail(row: BundleRow, options: BundleOptionRow[]): BundleDetail {
    const mapped: BundleOption[] = options.map(({ variant }) => {
      const firstMedia = variant.product.media[0];
      return {
        variantId: variant.id,
        productSlug: variant.product.slug,
        productName: variant.product.name,
        variantName: variant.name,
        packSize: variant.packSize,
        inStock: isAvailable(variant),
        image: firstMedia ? this.media(firstMedia) : null,
      };
    });
    return {
      ...this.bundleSummary(row),
      options: mapped,
      // A bundle can be built as long as one option is available (picks may repeat).
      inStock: mapped.some((o) => o.inStock),
    };
  }
}
