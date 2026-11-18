import { describe, expect, it } from 'vitest';
import { assertPaise, formatINR, MoneyError, rupeesToPaise } from './money.js';

describe('rupeesToPaise', () => {
  it.each([
    ['399', 39900],
    ['399.5', 39950],
    ['399.50', 39950],
    ['0.01', 1],
    ['0', 0],
    [' 49 ', 4900],
    ['0.1', 10],
  ])('parses %s → %i paise', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each(['', '-1', '1e3', '399.505', '3,99', 'abc', '.5', '1.', 'NaN', 'Infinity'])(
    'rejects %j',
    (input) => {
      expect(() => rupeesToPaise(input)).toThrow(MoneyError);
    },
  );

  it('avoids float error (0.29 → 29, not 28.999…)', () => {
    expect(rupeesToPaise('0.29')).toBe(29);
    expect(rupeesToPaise('1.15')).toBe(115);
  });
});

describe('assertPaise', () => {
  it('accepts non-negative integers', () => {
    expect(() => assertPaise(0)).not.toThrow();
    expect(() => assertPaise(39900)).not.toThrow();
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (value) => {
      expect(() => assertPaise(value)).toThrow(MoneyError);
    },
  );
});

describe('formatINR', () => {
  it.each([
    [39900, '₹399'],
    [39950, '₹399.50'],
    [1, '₹0.01'],
    [0, '₹0'],
    [12345600, '₹1,23,456'],
    [-39900, '-₹399'],
    [-5, '-₹0.05'],
  ])('formats %i as %s', (paise, expected) => {
    expect(formatINR(paise)).toBe(expected);
  });

  it('rejects non-integer paise', () => {
    expect(() => formatINR(1.5)).toThrow(MoneyError);
  });
});
