import type { OrderStatus } from '@brand/shared';
import { variantDemand } from '../cart/cart-lines.js';

/**
 * What a status change does to inventory (CLAUDE.md §6, §8):
 *   reserve   – prepaid order placed: hold stock for payment
 *   deduct    – COD (or ₹0) order placed: take stock now
 *   confirm   – reserved prepaid order paid: take stock, drop the hold
 *   release   – unpaid order cancelled or expired: drop the hold
 *   restock   – confirmed order cancelled before dispatch: put stock back
 */
export type StockEffect = 'reserve' | 'deduct' | 'confirm' | 'release' | 'restock' | null;

const HOLDING: readonly OrderStatus[] = ['pending_payment', 'payment_failed'];
const TAKEN: readonly OrderStatus[] = ['confirmed', 'packed'];

export function stockEffect(from: OrderStatus | null, to: OrderStatus): StockEffect {
  if (from === null)
    return to === 'pending_payment' ? 'reserve' : to === 'confirmed' ? 'deduct' : null;
  if (HOLDING.includes(from) && to === 'confirmed') return 'confirm';
  if (HOLDING.includes(from) && to === 'cancelled') return 'release';
  if (TAKEN.includes(from) && to === 'cancelled') return 'restock';
  // payment_failed keeps the hold: the customer may retry on the same Razorpay order.
  // Returned (RTO) stock goes back only after warehouse inspection (Phase 3).
  return null;
}

export interface OrderItemStockRow {
  variantId: string | null;
  bundleSelection: unknown;
  quantity: number;
}

/** Packs per variant an order uses: variant lines plus every bundle pick. */
export function orderDemand(items: readonly OrderItemStockRow[]): Map<string, number> {
  return variantDemand(
    items.map((item) => ({
      variantId: item.variantId,
      bundleId: item.variantId ? null : 'bundle',
      selection:
        Array.isArray(item.bundleSelection) &&
        item.bundleSelection.every((v): v is string => typeof v === 'string')
          ? item.bundleSelection
          : null,
      quantity: item.quantity,
    })),
  );
}
