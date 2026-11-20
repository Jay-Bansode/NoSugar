import { describe, expect, it } from 'vitest';
import {
  allowedOrderTransitions,
  assertOrderTransition,
  canTransitionOrder,
  initialOrderStatus,
  InvalidOrderTransitionError,
  isCancellable,
  isTerminalOrderStatus,
  ORDER_STATUSES,
  type OrderStatus,
} from './order-status.js';

describe('order status machine', () => {
  it('follows the happy path from CLAUDE.md §5', () => {
    const path: OrderStatus[] = [
      'pending_payment',
      'confirmed',
      'packed',
      'shipped',
      'out_for_delivery',
      'delivered',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionOrder(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['pending_payment', 'payment_failed'],
    ['pending_payment', 'cancelled'],
    ['confirmed', 'cancelled'],
    ['packed', 'cancelled'],
    ['shipped', 'undelivered'],
    ['undelivered', 'out_for_delivery'],
    ['undelivered', 'rto'],
    ['rto', 'returned'],
    ['delivered', 'refunded'],
    ['delivered', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
    ['payment_failed', 'confirmed'],
  ])('allows %s → %s', (from, to) => {
    expect(() => assertOrderTransition(from, to)).not.toThrow();
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['shipped', 'cancelled'], // no cancellation after dispatch
    ['out_for_delivery', 'cancelled'],
    ['delivered', 'shipped'],
    ['pending_payment', 'shipped'], // must be paid first
    ['cancelled', 'confirmed'],
    ['refunded', 'delivered'],
    ['rto', 'delivered'],
    ['confirmed', 'confirmed'],
  ])('rejects %s → %s', (from, to) => {
    expect(() => assertOrderTransition(from, to)).toThrow(InvalidOrderTransitionError);
  });

  it('has a transition entry for every status, pointing only at known statuses', () => {
    for (const status of ORDER_STATUSES) {
      for (const next of allowedOrderTransitions(status)) {
        expect(ORDER_STATUSES).toContain(next);
      }
    }
  });

  it('every status is reachable from an initial status', () => {
    const seen = new Set<OrderStatus>([initialOrderStatus('prepaid'), initialOrderStatus('cod')]);
    const queue = [...seen];
    while (queue.length > 0) {
      for (const next of allowedOrderTransitions(queue.shift()!)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('treats cancelled and refunded as terminal', () => {
    expect(isTerminalOrderStatus('cancelled')).toBe(true);
    expect(isTerminalOrderStatus('refunded')).toBe(true);
    expect(isTerminalOrderStatus('delivered')).toBe(false);
  });

  it('starts prepaid orders in pending_payment and COD orders confirmed', () => {
    expect(initialOrderStatus('prepaid')).toBe('pending_payment');
    expect(initialOrderStatus('cod')).toBe('confirmed');
  });

  it('allows cancellation only before dispatch', () => {
    expect(isCancellable('confirmed')).toBe(true);
    expect(isCancellable('packed')).toBe(true);
    expect(isCancellable('shipped')).toBe(false);
    expect(isCancellable('delivered')).toBe(false);
  });
});
