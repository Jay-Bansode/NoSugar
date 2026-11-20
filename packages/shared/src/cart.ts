import { z } from 'zod';
import { mediaSchema } from './catalog.js';
import { PAYMENT_METHODS } from './order-status.js';

/**
 * Cart API (CLAUDE.md §6 step 1, §7). The cart lives on the server. Guests identify their cart
 * with the `X-Cart-Id` header; logged-in customers have one cart, and a guest cart sent by a
 * logged-in request is merged into it.
 */
export const CART_ID_HEADER = 'x-cart-id';
export const MAX_CART_LINES = 50;
export const MAX_ITEM_QUANTITY = 99;
/** Bundles have at most this many picks. */
export const MAX_BUNDLE_SLOTS = 10;

const quantitySchema = z.number().int().min(1).max(MAX_ITEM_QUANTITY);

export const addVariantItemSchema = z.strictObject({
  variantId: z.uuid(),
  quantity: quantitySchema.default(1),
});

export const addBundleItemSchema = z.strictObject({
  bundleId: z.uuid(),
  quantity: quantitySchema.default(1),
  /** Chosen variant ids, one per bundle slot; the same pack may repeat. */
  selection: z.array(z.uuid()).min(1).max(MAX_BUNDLE_SLOTS),
});

export const addCartItemSchema = z.union([addVariantItemSchema, addBundleItemSchema]);
export type AddCartItem = z.infer<typeof addCartItemSchema>;

export const updateCartItemSchema = z.strictObject({ quantity: quantitySchema });
export type UpdateCartItem = z.infer<typeof updateCartItemSchema>;

export const updateCartSchema = z.strictObject({
  /** null removes the code. */
  discountCode: z.string().trim().min(1).max(40).nullable(),
});
export type UpdateCart = z.infer<typeof updateCartSchema>;

export const cartQuerySchema = z.object({
  /** Totals preview for this payment method (COD adds its fee). */
  paymentMethod: z.enum(PAYMENT_METHODS).default('prepaid'),
});
export type CartQuery = z.infer<typeof cartQuerySchema>;

export const cartIdSchema = z.uuid();

/** Why a line can't be bought right now; such lines are left out of the totals. */
export const CART_LINE_ISSUES = ['UNAVAILABLE', 'OUT_OF_STOCK', 'PURCHASE_LIMIT'] as const;
export const cartLineIssueSchema = z.enum(CART_LINE_ISSUES);
export type CartLineIssue = z.infer<typeof cartLineIssueSchema>;

export const cartLineSchema = z.object({
  id: z.string(),
  kind: z.enum(['variant', 'bundle']),
  variantId: z.string().nullable(),
  bundleId: z.string().nullable(),
  selection: z.array(z.string()).nullable(),
  /** Product (or bundle) slug for linking back to its page. */
  slug: z.string().nullable(),
  name: z.string(),
  variantName: z.string(),
  image: mediaSchema.nullable(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int().nullable(),
  lineTotalPaise: z.number().int().nullable(),
  issue: cartLineIssueSchema.nullable(),
});
export type CartLine = z.infer<typeof cartLineSchema>;

export const cartTotalsSchema = z.object({
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  walletPaise: z.number().int(),
  shippingPaise: z.number().int(),
  codFeePaise: z.number().int(),
  /** GST included in the total. */
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
  amountToFreeShippingPaise: z.number().int(),
});
export type CartTotals = z.infer<typeof cartTotalsSchema>;

export const cartSchema = z.object({
  /** null until the first item is added. */
  id: z.string().nullable(),
  isGuest: z.boolean(),
  lines: z.array(cartLineSchema),
  discountCode: z.string().nullable(),
  /** Why the saved code isn't applied right now (expired, minimum not met…). */
  discountMessage: z.string().nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  codAvailable: z.boolean(),
  /** null when nothing in the cart can be bought. */
  totals: cartTotalsSchema.nullable(),
});
export type Cart = z.infer<typeof cartSchema>;
