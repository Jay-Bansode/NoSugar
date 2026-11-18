/**
 * Order status state machine (CLAUDE.md §5). This table is the single source of truth:
 * the API service layer must call `assertOrderTransition` before every status change.
 */

export const ORDER_STATUSES = [
  'pending_payment',
  'payment_failed',
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
  'undelivered',
  'rto',
  'returned',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['prepaid', 'cod'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['confirmed', 'payment_failed', 'cancelled'],
  // A customer can retry on the same Razorpay order, so a capture webhook may still arrive.
  payment_failed: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  // Couriers sometimes report Delivered without an Out-for-delivery scan.
  shipped: ['out_for_delivery', 'delivered', 'undelivered', 'rto'],
  out_for_delivery: ['delivered', 'undelivered', 'rto'],
  // Reattempt goes back out for delivery.
  undelivered: ['out_for_delivery', 'delivered', 'rto'],
  rto: ['returned'],
  // A returned prepaid order is refunded.
  returned: ['refunded'],
  delivered: ['refunded', 'partially_refunded'],
  // Further partial refunds keep the status; a final one makes it fully refunded.
  partially_refunded: ['refunded'],
  cancelled: [],
  refunded: [],
};

export class InvalidOrderTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(`Invalid order status transition: ${from} → ${to}`);
    this.name = 'InvalidOrderTransitionError';
  }
}

export function allowedOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws InvalidOrderTransitionError unless `from → to` is allowed. */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Prepaid orders wait for payment; COD orders skip the payment steps (CLAUDE.md §6 step 8). */
export function initialOrderStatus(method: PaymentMethod): OrderStatus {
  return method === 'cod' ? 'confirmed' : 'pending_payment';
}

/** Customers (and support) may cancel only before dispatch. */
export function isCancellable(status: OrderStatus): boolean {
  return canTransitionOrder(status, 'cancelled');
}
