import { z } from 'zod';
import { cursorQuerySchema } from './pagination.js';

/**
 * Public catalog API shapes (CLAUDE.md §7). Prices are tax-inclusive paise.
 * Deliberately not exposed: stock counts, HSN codes, GST rates, inactive items.
 */

export const PRODUCT_TYPES = ['coffee', 'trial_kit', 'gift_set', 'merchandise'] as const;
export const productTypeSchema = z.enum(PRODUCT_TYPES);
export type ProductType = z.infer<typeof productTypeSchema>;

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug')
  .max(100);

export const productListQuerySchema = cursorQuerySchema.extend({
  cursor: z.uuid().optional(),
  type: productTypeSchema.optional(),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const mediaSchema = z.object({
  url: z.string(),
  alt: z.string(),
});
export type Media = z.infer<typeof mediaSchema>;

export const variantSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  /** Sachets per pack; null for non-sachet items. */
  packSize: z.number().int().nullable(),
  mrpPaise: z.number().int(),
  pricePaise: z.number().int(),
  inStock: z.boolean(),
});
export type Variant = z.infer<typeof variantSchema>;

export const productSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: productTypeSchema,
  /** Limited to one per customer (the trial kit). */
  onePerCustomer: z.boolean(),
  /** Lowest active variant price, for "from ₹…" labels. */
  fromPricePaise: z.number().int(),
  fromMrpPaise: z.number().int(),
  inStock: z.boolean(),
  image: mediaSchema.nullable(),
});
export type ProductSummary = z.infer<typeof productSummarySchema>;

export const productDetailSchema = productSummarySchema.extend({
  description: z.string().nullable(),
  variants: z.array(variantSchema),
  media: z.array(mediaSchema),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

export const collectionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  products: z.array(productSummarySchema),
});
export type Collection = z.infer<typeof collectionSchema>;

export const bundleSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Number of packs the customer picks. */
  slots: z.number().int(),
  mrpPaise: z.number().int(),
  pricePaise: z.number().int(),
});
export type BundleSummary = z.infer<typeof bundleSummarySchema>;

export const bundleOptionSchema = z.object({
  variantId: z.string(),
  productSlug: z.string(),
  productName: z.string(),
  variantName: z.string(),
  packSize: z.number().int().nullable(),
  inStock: z.boolean(),
  image: mediaSchema.nullable(),
});
export type BundleOption = z.infer<typeof bundleOptionSchema>;

export const bundleDetailSchema = bundleSummarySchema.extend({
  /** Packs the customer can choose from (the same pack may be picked more than once). */
  options: z.array(bundleOptionSchema),
  inStock: z.boolean(),
});
export type BundleDetail = z.infer<typeof bundleDetailSchema>;
