import { describe, expect, it } from 'vitest';
import {
  adminRefundSchema,
  type RefundBasis,
  refundablePaise,
  RefundRuleError,
  statusAfterRefund,
} from './admin-orders.js';

const prepaid = (over: Partial<RefundBasis> = {}): RefundBasis => ({
  status: 'delivered',
  paymentMethod: 'prepaid',
  totalPaise: 69900,
  codFeePaise: 0,
  capturedPaise: 69900,
  refunds: [],
  ...over,
});
const cod = (over: Partial<RefundBasis> = {}): RefundBasis =>
  prepaid({
    paymentMethod: 'cod',
    totalPaise: 74800,
    codFeePaise: 4900,
    capturedPaise: 0,
    ...over,
  });

describe('refundablePaise', () => {
  it('is what was paid online, less refunds that did not fail', () => {
    expect(refundablePaise(prepaid())).toBe(69900);
    expect(
      refundablePaise(
        prepaid({
          refunds: [
            { amountPaise: 10000, status: 'processed' },
            { amountPaise: 5000, status: 'pending' },
            { amountPaise: 20000, status: 'failed' },
          ],
        }),
      ),
    ).toBe(54900);
  });

  it('for COD, is the cash collected on delivery minus the non-refundable COD fee', () => {
    expect(refundablePaise(cod())).toBe(69900);
    expect(refundablePaise(cod({ status: 'returned' }))).toBe(0); // never paid
    expect(refundablePaise(cod({ status: 'confirmed' }))).toBe(0);
  });

  it('never goes below zero', () => {
    expect(
      refundablePaise(prepaid({ refunds: [{ amountPaise: 99999, status: 'processed' }] })),
    ).toBe(0);
  });
});

describe('statusAfterRefund', () => {
  it('a partial refund of a delivered order makes it partially refunded', () => {
    expect(statusAfterRefund(prepaid(), 10000)).toBe('partially_refunded');
  });

  it('refunding everything left makes it refunded', () => {
    expect(statusAfterRefund(prepaid(), 69900)).toBe('refunded');
    const partly = prepaid({
      status: 'partially_refunded',
      refunds: [{ amountPaise: 10000, status: 'processed' }],
    });
    expect(statusAfterRefund(partly, 59900)).toBe('refunded');
    expect(statusAfterRefund(partly, 100)).toBeNull(); // stays partially refunded
  });

  it('a returned order is refunded in full only', () => {
    expect(statusAfterRefund(prepaid({ status: 'returned' }), 69900)).toBe('refunded');
    expect(() => statusAfterRefund(prepaid({ status: 'returned' }), 100)).toThrow(/in full/);
  });

  it('refuses orders that are not delivered or returned, and amounts over the limit', () => {
    for (const status of ['confirmed', 'packed', 'shipped', 'cancelled', 'refunded'] as const) {
      expect(() => statusAfterRefund(prepaid({ status }), 100)).toThrow(RefundRuleError);
    }
    expect(() => statusAfterRefund(prepaid(), 69901)).toThrow(/At most 69900/);
    expect(() => statusAfterRefund(cod(), 74800)).toThrow(/At most 69900/); // COD fee kept
    expect(() => statusAfterRefund(prepaid(), 0)).toThrow(RefundRuleError);
    expect(() => statusAfterRefund(prepaid(), 1.5)).toThrow();
  });
});

describe('adminRefundSchema', () => {
  it('needs a reference for manual refunds', () => {
    const base = { amountPaise: 100, reason: 'Damaged pack' };
    expect(adminRefundSchema.safeParse({ ...base, method: 'razorpay' }).success).toBe(true);
    expect(adminRefundSchema.safeParse({ ...base, method: 'manual' }).success).toBe(false);
    expect(
      adminRefundSchema.safeParse({ ...base, method: 'manual', reference: 'UTR123456' }).success,
    ).toBe(true);
    expect(
      adminRefundSchema.safeParse({ ...base, amountPaise: 0, method: 'razorpay' }).success,
    ).toBe(false);
    expect(adminRefundSchema.safeParse({ ...base, reason: 'x', method: 'razorpay' }).success).toBe(
      false,
    );
  });
});
