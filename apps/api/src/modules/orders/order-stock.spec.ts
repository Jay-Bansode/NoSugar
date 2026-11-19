import { describe, expect, it } from 'vitest';
import { orderDemand, stockEffect } from './order-stock.js';

describe('stockEffect', () => {
  it.each([
    [null, 'pending_payment', 'reserve'],
    [null, 'confirmed', 'deduct'],
    ['pending_payment', 'confirmed', 'confirm'],
    ['payment_failed', 'confirmed', 'confirm'],
    ['pending_payment', 'cancelled', 'release'],
    ['payment_failed', 'cancelled', 'release'],
    ['confirmed', 'cancelled', 'restock'],
    ['packed', 'cancelled', 'restock'],
    ['pending_payment', 'payment_failed', null], // keep the hold for a retry
    ['confirmed', 'packed', null],
    ['shipped', 'delivered', null],
    ['rto', 'returned', null],
  ] as const)('%s → %s = %s', (from, to, effect) => {
    expect(stockEffect(from, to)).toBe(effect);
  });
});

describe('orderDemand', () => {
  it('counts variant lines and each bundle pick per bundle ordered', () => {
    const demand = orderDemand([
      { variantId: 'a', bundleSelection: null, quantity: 2 },
      { variantId: null, bundleSelection: ['a', 'b'], quantity: 3 },
      { variantId: null, bundleSelection: ['b', 'b'], quantity: 1 },
    ]);
    expect(Object.fromEntries(demand)).toEqual({ a: 5, b: 5 });
  });

  it('ignores malformed bundle selections', () => {
    expect(orderDemand([{ variantId: null, bundleSelection: { x: 1 }, quantity: 1 }]).size).toBe(0);
  });
});
