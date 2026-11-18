import { describe, expect, it } from 'vitest';
import { MoneyError } from './money.js';
import { lineTax, splitGst, taxFromInclusive } from './tax.js';

describe('taxFromInclusive', () => {
  it('₹399 at 5% contains ₹19.00 GST', () => {
    expect(taxFromInclusive(39900, 500)).toBe(1900);
  });

  it('₹399 at 18% contains ₹60.86 GST (6086.44 rounds down)', () => {
    expect(taxFromInclusive(39900, 1800)).toBe(6086);
  });

  it('₹399 at 12% contains ₹42.75 GST (4275 exactly)', () => {
    expect(taxFromInclusive(39900, 1200)).toBe(4275);
  });

  it('rounds half up', () => {
    // 21 × 500 / 10500 = 1.0 → 1; 31 → 1.476 → 1; 32 → 1.523 → 2
    expect(taxFromInclusive(21, 500)).toBe(1);
    expect(taxFromInclusive(31, 500)).toBe(1);
    expect(taxFromInclusive(32, 500)).toBe(2);
    // Exact half: 14 × 1200 / 11200 = 1.5 → 2
    expect(taxFromInclusive(14, 1200)).toBe(2);
  });

  it('returns 0 for a 0% rate and for ₹0', () => {
    expect(taxFromInclusive(39900, 0)).toBe(0);
    expect(taxFromInclusive(0, 1800)).toBe(0);
  });

  it('handles ₹1', () => {
    expect(taxFromInclusive(100, 500)).toBe(5); // 4.76 → 5
  });

  it('always returns an integer between 0 and the price', () => {
    for (const price of [1, 99, 4900, 39900, 99999]) {
      for (const bps of [0, 500, 1200, 1800, 2800]) {
        const tax = taxFromInclusive(price, bps);
        expect(Number.isInteger(tax)).toBe(true);
        expect(tax).toBeGreaterThanOrEqual(0);
        expect(tax).toBeLessThanOrEqual(price);
      }
    }
  });

  it.each([
    [1.5, 500],
    [-100, 500],
    [100, -1],
    [100, 12.5],
    [100, 10_001],
  ])('rejects invalid input (%s, %s)', (price, bps) => {
    expect(() => taxFromInclusive(price, bps)).toThrow(MoneyError);
  });
});

describe('lineTax', () => {
  it('computes on the line total, not per unit', () => {
    // Per unit: 31 → 1 paisa each, ×3 = 3. On the total: 93 × 500/10500 = 4.43 → 4.
    expect(lineTax(31, 3, 500)).toBe(4);
  });

  it('rejects non-positive or fractional quantities', () => {
    expect(() => lineTax(39900, 0, 500)).toThrow(MoneyError);
    expect(() => lineTax(39900, 1.5, 500)).toThrow(MoneyError);
  });
});

describe('splitGst', () => {
  it('splits into CGST + SGST within the seller state', () => {
    expect(splitGst(1900, '27', '27')).toEqual({ kind: 'intra', cgstPaise: 950, sgstPaise: 950 });
  });

  it('puts the odd paisa on SGST so the parts sum to the total', () => {
    const split = splitGst(6087, '27', '27');
    expect(split).toEqual({ kind: 'intra', cgstPaise: 3043, sgstPaise: 3044 });
  });

  it('uses IGST across states', () => {
    expect(splitGst(6086, '27', '29')).toEqual({ kind: 'inter', igstPaise: 6086 });
  });

  it('requires both state codes', () => {
    expect(() => splitGst(100, '', '27')).toThrow(MoneyError);
  });
});
