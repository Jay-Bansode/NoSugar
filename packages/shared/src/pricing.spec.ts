import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  type PriceQuote,
  type PricingFees,
  type PricingInput,
  type PricingLine,
  PricingError,
  priceOrder,
} from './pricing.js';
import { taxFromInclusive } from './tax.js';

const FEES: PricingFees = {
  freeShippingThresholdPaise: 39900,
  shippingFeePaise: 9900,
  codFeePaise: 4900,
  codEnabled: true,
};

function line(overrides: Partial<PricingLine> = {}): PricingLine {
  return {
    key: 'l1',
    unitPricePaise: 29900,
    quantity: 1,
    gstRateBps: 500,
    discountable: true,
    walletEligible: false,
    ...overrides,
  };
}

const sixPack = (q = 1) => line({ key: 'six', unitPricePaise: 29900, quantity: q });
const fifteenPack = (q = 1) =>
  line({ key: 'fifteen', unitPricePaise: 69900, quantity: q, walletEligible: true });
const trialKit = () =>
  line({ key: 'trial', unitPricePaise: 39900, gstRateBps: 1800, discountable: false });

function price(overrides: Partial<PricingInput> = {}): PriceQuote {
  return priceOrder({ lines: [sixPack()], fees: FEES, paymentMethod: 'prepaid', ...overrides });
}

/** Invariants every quote must satisfy (mirrors the orders table CHECKs). */
function expectConsistent(q: PriceQuote): void {
  expect(q.totalPaise).toBe(
    q.subtotalPaise - q.discountPaise - q.walletPaise + q.shippingPaise + q.codFeePaise,
  );
  expect(q.lines.reduce((s, l) => s + l.lineTotalPaise, 0)).toBe(q.subtotalPaise);
  expect(q.lines.reduce((s, l) => s + l.discountPaise, 0)).toBe(q.discountPaise);
  expect(q.lines.reduce((s, l) => s + l.walletPaise, 0)).toBe(q.walletPaise);
  expect(q.lines.reduce((s, l) => s + l.taxPaise, 0) + q.chargesTaxPaise).toBe(q.taxPaise);
  expect(q.taxPaise).toBeLessThanOrEqual(q.totalPaise + q.walletPaise);
  for (const value of [q.totalPaise, q.taxPaise, q.discountPaise, q.walletPaise]) {
    expect(Number.isInteger(value) && value >= 0).toBe(true);
  }
  for (const l of q.lines) {
    expect(l.discountPaise + l.walletPaise).toBeLessThanOrEqual(l.lineTotalPaise);
  }
}

describe('allocateProportionally', () => {
  it('splits exactly, in proportion', () => {
    expect(allocateProportionally(100, [1, 1, 2])).toEqual([25, 25, 50]);
  });

  it('gives leftover paise to the largest remainders, earlier lines on ties', () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(10, [3, 7])).toEqual([3, 7]);
    expect(allocateProportionally(5, [1, 2])).toEqual([2, 3]); // 1.67 / 3.33
  });

  it('gives nothing to zero-weight lines', () => {
    expect(allocateProportionally(100, [0, 50, 0])).toEqual([0, 100, 0]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportionally(10, [0, 0])).toEqual([0, 0]);
  });

  it('never gives a part more than its weight when the amount fits', () => {
    for (let amount = 0; amount <= 10; amount++) {
      const weights = [3, 1, 4, 1, 1];
      allocateProportionally(amount, weights).forEach((part, i) => {
        expect(part).toBeLessThanOrEqual(weights[i]!);
      });
    }
  });

  it('always sums to the amount (sweep)', () => {
    for (let amount = 0; amount <= 300; amount += 7) {
      const weights = [29900, 69900, 1, 12345];
      const parts = allocateProportionally(amount, weights);
      expect(parts.reduce((s, p) => s + p, 0)).toBe(amount);
    }
  });
});

describe('shipping', () => {
  it('charges ₹99 below the ₹399 threshold', () => {
    const q = price();
    expect(q.shippingPaise).toBe(9900);
    expect(q.amountToFreeShippingPaise).toBe(10000);
    expect(q.totalPaise).toBe(39800);
    expectConsistent(q);
  });

  it('is free at exactly the threshold (≥)', () => {
    const q = price({ lines: [line({ unitPricePaise: 39900 })] });
    expect(q.shippingPaise).toBe(0);
    expect(q.amountToFreeShippingPaise).toBe(0);
    expect(q.totalPaise).toBe(39900);
  });

  it('checks the threshold after the discount', () => {
    // ₹419 − ₹30 = ₹389 < ₹399 → shipping is charged again
    const q = price({
      lines: [line({ unitPricePaise: 41900 })],
      discount: { type: 'fixed', valuePaise: 3000, minSubtotalPaise: 0 },
    });
    expect(q.shippingPaise).toBe(9900);
    expect(q.amountToFreeShippingPaise).toBe(1000);
    expectConsistent(q);
  });

  it('uses the configured fees', () => {
    const q = price({
      fees: { ...FEES, freeShippingThresholdPaise: 100000, shippingFeePaise: 4900 },
    });
    expect(q.shippingPaise).toBe(4900);
  });
});

describe('Cash on Delivery', () => {
  it('adds the COD fee only for COD', () => {
    expect(price({ paymentMethod: 'prepaid' }).codFeePaise).toBe(0);
    const q = price({ paymentMethod: 'cod' });
    expect(q.codFeePaise).toBe(4900);
    expect(q.totalPaise).toBe(29900 + 9900 + 4900);
    expectConsistent(q);
  });

  it('refuses COD when disabled in settings', () => {
    expect(() => price({ paymentMethod: 'cod', fees: { ...FEES, codEnabled: false } })).toThrow(
      PricingError,
    );
  });
});

describe('discounts', () => {
  it('applies a percentage, rounding down to whole paise', () => {
    // 10% of ₹299 = ₹29.90
    const q = price({
      discount: { type: 'percentage', valueBps: 1000, maxDiscountPaise: null, minSubtotalPaise: 0 },
    });
    expect(q.discountPaise).toBe(2990);
    expectConsistent(q);

    const odd = price({
      lines: [line({ unitPricePaise: 33333 })],
      discount: { type: 'percentage', valueBps: 1000, maxDiscountPaise: null, minSubtotalPaise: 0 },
    });
    expect(odd.discountPaise).toBe(3333); // 3333.3 → 3333
  });

  it('caps a percentage at maxDiscountPaise', () => {
    const q = price({
      lines: [fifteenPack(3)],
      discount: {
        type: 'percentage',
        valueBps: 2000,
        maxDiscountPaise: 20000,
        minSubtotalPaise: 0,
      },
    });
    expect(q.discountPaise).toBe(20000);
  });

  it('never discounts more than the discountable amount', () => {
    const q = price({ discount: { type: 'fixed', valuePaise: 1_000_000, minSubtotalPaise: 0 } });
    expect(q.discountPaise).toBe(29900);
    expect(q.lines[0]!.taxPaise).toBe(0);
    expect(q.totalPaise).toBe(9900); // shipping only
    expectConsistent(q);
  });

  it('skips the trial kit', () => {
    const q = price({
      lines: [trialKit(), sixPack()],
      discount: { type: 'percentage', valueBps: 5000, maxDiscountPaise: null, minSubtotalPaise: 0 },
    });
    expect(q.lines.find((l) => l.key === 'trial')!.discountPaise).toBe(0);
    expect(q.lines.find((l) => l.key === 'six')!.discountPaise).toBe(14950);
    expectConsistent(q);
  });

  it('gives nothing when only non-discountable lines are in the order', () => {
    const q = price({
      lines: [trialKit()],
      discount: { type: 'fixed', valuePaise: 5000, minSubtotalPaise: 0 },
    });
    expect(q.discountPaise).toBe(0);
  });

  it('flags and ignores a discount below its minimum order value', () => {
    const q = price({ discount: { type: 'fixed', valuePaise: 5000, minSubtotalPaise: 50000 } });
    expect(q.discountPaise).toBe(0);
    expect(q.discountBelowMinimum).toBe(true);
    expect(price().discountBelowMinimum).toBe(false);
  });

  it('splits the discount across lines in proportion, for per-line GST', () => {
    const q = price({
      lines: [sixPack(), fifteenPack()],
      discount: { type: 'fixed', valuePaise: 10000, minSubtotalPaise: 0 },
    });
    // 29900 : 69900 → 2996.0 : 7003.9… → 2996 + 7004
    expect(q.lines.map((l) => l.discountPaise)).toEqual([2996, 7004]);
    expectConsistent(q);
  });

  it('rejects an out-of-range percentage', () => {
    expect(() =>
      price({
        discount: { type: 'percentage', valueBps: 0, maxDiscountPaise: null, minSubtotalPaise: 0 },
      }),
    ).toThrow(PricingError);
  });
});

describe('wallet credit', () => {
  it('applies only to 15-sachet packs, up to the balance', () => {
    const q = price({ lines: [sixPack(), fifteenPack()], walletAvailablePaise: 39900 });
    expect(q.walletPaise).toBe(39900);
    expect(q.lines.find((l) => l.key === 'six')!.walletPaise).toBe(0);
    expect(q.lines.find((l) => l.key === 'fifteen')!.walletPaise).toBe(39900);
    expect(q.totalPaise).toBe(29900 + 69900 - 39900);
    expectConsistent(q);
  });

  it('is unusable without an eligible line', () => {
    const q = price({ lines: [sixPack()], walletAvailablePaise: 39900 });
    expect(q.walletPaise).toBe(0);
  });

  it('never exceeds what the eligible lines cost after discount', () => {
    const q = price({
      lines: [line({ key: 'cheap', unitPricePaise: 20000, walletEligible: true })],
      walletAvailablePaise: 39900,
      discount: { type: 'fixed', valuePaise: 5000, minSubtotalPaise: 0 },
    });
    expect(q.walletPaise).toBe(15000);
    expectConsistent(q);
  });

  it('is a payment, not a discount: GST and free shipping ignore it', () => {
    const withWallet = price({ lines: [fifteenPack()], walletAvailablePaise: 39900 });
    const without = price({ lines: [fifteenPack()] });
    expect(withWallet.taxPaise).toBe(without.taxPaise);
    expect(withWallet.shippingPaise).toBe(0);
    expectConsistent(withWallet);
  });
});

describe('GST', () => {
  it('computes each line on its discounted value', () => {
    const q = price({
      lines: [sixPack(), trialKit()],
      discount: { type: 'fixed', valuePaise: 2900, minSubtotalPaise: 0 },
    });
    const six = q.lines.find((l) => l.key === 'six')!;
    const trial = q.lines.find((l) => l.key === 'trial')!;
    expect(six.taxPaise).toBe(taxFromInclusive(29900 - 2900, 500));
    expect(trial.taxPaise).toBe(taxFromInclusive(39900, 1800));
  });

  it('taxes shipping and the COD fee at the highest line rate', () => {
    const q = price({
      lines: [
        line({ unitPricePaise: 10000 }),
        line({ key: 'b', unitPricePaise: 10000, gstRateBps: 1800 }),
      ],
      paymentMethod: 'cod',
    });
    expect(q.chargesTaxPaise).toBe(taxFromInclusive(9900 + 4900, 1800));
    expectConsistent(q);
  });

  it('adds no charges tax when shipping is free and prepaid', () => {
    expect(price({ lines: [fifteenPack()] }).chargesTaxPaise).toBe(0);
  });
});

describe('input checks', () => {
  it('rejects an empty order and bad quantities', () => {
    expect(() => price({ lines: [] })).toThrow(PricingError);
    expect(() => price({ lines: [line({ quantity: 0 })] })).toThrow(PricingError);
    expect(() => price({ lines: [line({ quantity: 1.5 })] })).toThrow(PricingError);
    expect(() => price({ lines: [line({ unitPricePaise: 1.5 })] })).toThrow();
  });
});

describe('invariants hold across many random orders', () => {
  // Small deterministic PRNG so failures are reproducible.
  let seed = 42;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };

  it('500 orders', () => {
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + rand(4) }, (_, k) =>
        line({
          key: `k${k}`,
          unitPricePaise: 100 + rand(150000),
          quantity: 1 + rand(5),
          gstRateBps: [0, 500, 1200, 1800][rand(4)]!,
          discountable: rand(5) !== 0,
          walletEligible: rand(3) === 0,
        }),
      );
      const discount =
        rand(3) === 0
          ? null
          : rand(2) === 0
            ? {
                type: 'percentage' as const,
                valueBps: 1 + rand(10000),
                maxDiscountPaise: rand(2) ? null : 1 + rand(50000),
                minSubtotalPaise: rand(60000),
              }
            : {
                type: 'fixed' as const,
                valuePaise: 1 + rand(80000),
                minSubtotalPaise: rand(60000),
              };
      const q = priceOrder({
        lines,
        fees: FEES,
        paymentMethod: rand(2) ? 'cod' : 'prepaid',
        discount,
        walletAvailablePaise: rand(80000),
      });
      expectConsistent(q);
    }
  });
});
