import { z } from 'zod';
import { shippingAddressSchema } from './address.js';
import { assertPaise, type Paise } from './money.js';
import {
  ORDER_STATUSES,
  type OrderStatus,
  PAYMENT_METHODS,
  type PaymentMethod,
} from './order-status.js';
import { creditNoteSummarySchema, invoiceSummarySchema, orderStatusSchema } from './orders.js';
import { cursorQuerySchema } from './pagination.js';

/**
 * Admin orders: list, detail, packing, cancellation and refunds (Phase 2 slice 3).
 * Refund rules live here as pure functions so the API and the admin panel agree.
 */

export const REFUND_METHODS = ['razorpay', 'manual'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** Orders whose money can be given back from the admin panel (before dispatch: cancel instead). */
export const REFUNDABLE_STATUSES: readonly OrderStatus[] = [
  'delivered',
  'partially_refunded',
  'returned',
];

/** COD cash is collected on delivery; the COD fee is never refunded (CLAUDE.md §1). */
const COD_COLLECTED: readonly OrderStatus[] = ['delivered', 'partially_refunded', 'refunded'];

export interface RefundBasis {
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  totalPaise: Paise;
  codFeePaise: Paise;
  /** Sum of captured online payments (prepaid). */
  capturedPaise: Paise;
  refunds: readonly { amountPaise: Paise; status: 'pending' | 'processed' | 'failed' }[];
}

/**
 * Cash that can still be refunded: what the customer paid us (online, or COD cash minus the
 * non-refundable COD fee), less refunds already made or in progress. Wallet credit used on the
 * order is not cash and is not included.
 */
export function refundablePaise(basis: RefundBasis): Paise {
  const paid =
    basis.paymentMethod === 'prepaid'
      ? basis.capturedPaise
      : COD_COLLECTED.includes(basis.status)
        ? basis.totalPaise - basis.codFeePaise
        : 0;
  const refunded = basis.refunds
    .filter((r) => r.status !== 'failed')
    .reduce((sum, r) => sum + r.amountPaise, 0);
  return Math.max(0, paid - refunded);
}

export class RefundRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundRuleError';
  }
}

/**
 * Order status after refunding `amountPaise` now. Null: the status stays (a further partial
 * refund). Throws when the refund isn't allowed.
 */
export function statusAfterRefund(basis: RefundBasis, amountPaise: Paise): OrderStatus | null {
  assertPaise(amountPaise, 'amountPaise');
  if (!REFUNDABLE_STATUSES.includes(basis.status)) {
    throw new RefundRuleError(
      'Only delivered or returned orders can be refunded here; cancel orders that haven’t shipped.',
    );
  }
  const available = refundablePaise(basis);
  if (amountPaise < 1) throw new RefundRuleError('Enter an amount to refund.');
  if (amountPaise > available) {
    throw new RefundRuleError(`At most ${available} paise can be refunded on this order.`);
  }
  const full = amountPaise === available;
  if (basis.status === 'returned') {
    if (!full) throw new RefundRuleError('A returned order is refunded in full.');
    return 'refunded';
  }
  if (full) return 'refunded';
  return basis.status === 'delivered' ? 'partially_refunded' : null;
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────

export const adminOrderListQuerySchema = cursorQuerySchema.extend({
  cursor: z.uuid().optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  /** Order number (or its start), or the customer's mobile number. */
  q: z.string().trim().max(40).optional(),
});
export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

const reason = z.string().trim().min(3, 'Give a short reason').max(300);

export const adminCancelOrderSchema = z.object({ reason });
export type AdminCancelOrder = z.infer<typeof adminCancelOrderSchema>;

export const adminRefundSchema = z
  .object({
    amountPaise: z.number().int().min(1, 'Enter an amount to refund'),
    reason,
    method: z.enum(REFUND_METHODS),
    /** Bank/UPI transaction reference (UTR) for a manual refund. */
    reference: z.string().trim().max(100).optional(),
  })
  .refine((v) => v.method !== 'manual' || (v.reference && v.reference.length >= 4), {
    path: ['reference'],
    message: 'Enter the bank or UPI reference for a manual refund',
  });
export type AdminRefund = z.infer<typeof adminRefundSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────────────────

export const adminOrderSummarySchema = z.object({
  number: z.string(),
  status: orderStatusSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  createdAt: z.string(),
  totalPaise: z.number().int(),
  itemCount: z.number().int(),
  customerName: z.string(),
  customerPhone: z.string().nullable(),
  city: z.string(),
});
export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;

export const adminOrderDetailSchema = z.object({
  number: z.string(),
  status: orderStatusSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  createdAt: z.string(),
  customer: z.object({
    id: z.string(),
    phone: z.string().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  shippingAddress: shippingAddressSchema,
  discountCode: z.string().nullable(),
  lines: z.array(
    z.object({
      name: z.string(),
      variantName: z.string(),
      sku: z.string(),
      hsnCode: z.string(),
      gstRateBps: z.number().int(),
      quantity: z.number().int(),
      unitPricePaise: z.number().int(),
      lineTotalPaise: z.number().int(),
      discountPaise: z.number().int(),
      taxPaise: z.number().int(),
    }),
  ),
  totals: z.object({
    subtotalPaise: z.number().int(),
    discountPaise: z.number().int(),
    walletPaise: z.number().int(),
    shippingPaise: z.number().int(),
    codFeePaise: z.number().int(),
    taxPaise: z.number().int(),
    totalPaise: z.number().int(),
  }),
  timeline: z.array(
    z.object({
      from: orderStatusSchema.nullable(),
      to: orderStatusSchema,
      at: z.string(),
      actor: z.enum(['system', 'customer', 'admin', 'webhook']),
      note: z.string().nullable(),
    }),
  ),
  payments: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['created', 'authorized', 'captured', 'failed']),
      method: z.string().nullable(),
      amountPaise: z.number().int(),
      razorpayOrderId: z.string(),
      razorpayPaymentId: z.string().nullable(),
      capturedAt: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  refunds: z.array(
    z.object({
      id: z.string(),
      amountPaise: z.number().int(),
      status: z.enum(['pending', 'processed', 'failed']),
      method: z.enum(REFUND_METHODS),
      reason: z.string(),
      reference: z.string().nullable(),
      razorpayRefundId: z.string().nullable(),
      createdBy: z.string(),
      createdAt: z.string(),
      processedAt: z.string().nullable(),
    }),
  ),
  invoice: invoiceSummarySchema.nullable(),
  creditNotes: z.array(creditNoteSummarySchema),
  refundablePaise: z.number().int(),
  /** What the state machine allows now (the panel also hides actions by role). */
  can: z.object({ pack: z.boolean(), cancel: z.boolean(), refund: z.boolean() }),
});
export type AdminOrderDetail = z.infer<typeof adminOrderDetailSchema>;
