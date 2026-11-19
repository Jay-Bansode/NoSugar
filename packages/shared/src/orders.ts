import { z } from 'zod';
import { addressInputSchema, shippingAddressSchema } from './address.js';
import { ORDER_STATUSES, PAYMENT_METHODS } from './order-status.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const idempotencyKeySchema = z.uuid('Idempotency-Key must be a UUID');

/** Order numbers: placeholder brand prefix + sequence (e.g. "BR1000001"). */
export const ORDER_NUMBER_PREFIX = 'BR';
export const orderNumberSchema = z.string().regex(/^[A-Z]{2}\d{7,}$/, 'Invalid order number');

export const checkoutSchema = z.strictObject({
  paymentMethod: z.enum(PAYMENT_METHODS),
  address: addressInputSchema,
  /** Also save this address to the customer's address book. */
  saveAddress: z.boolean().default(false),
});
export type CheckoutRequest = z.infer<typeof checkoutSchema>;

export const orderLineSchema = z.object({
  name: z.string(),
  variantName: z.string(),
  sku: z.string(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  lineTotalPaise: z.number().int(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderTotalsSchema = z.object({
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  walletPaise: z.number().int(),
  shippingPaise: z.number().int(),
  codFeePaise: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
});

export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const orderDetailSchema = z.object({
  number: z.string(),
  status: orderStatusSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  createdAt: z.string(),
  lines: z.array(orderLineSchema),
  totals: orderTotalsSchema,
  shippingAddress: shippingAddressSchema,
  /** Prepaid orders must be paid by then or they are cancelled. */
  payBy: z.string().nullable(),
  canCancel: z.boolean(),
  timeline: z.array(z.object({ status: orderStatusSchema, at: z.string() })),
  /** Razorpay checkout details for unpaid prepaid orders (added with payments). */
  payment: z.null(),
});
export type OrderDetail = z.infer<typeof orderDetailSchema>;

export const orderSummarySchema = z.object({
  number: z.string(),
  status: orderStatusSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  createdAt: z.string(),
  totalPaise: z.number().int(),
  itemCount: z.number().int(),
  firstItemName: z.string(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;
