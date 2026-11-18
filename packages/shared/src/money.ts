/**
 * Money helpers. All amounts are integer paise (₹1 = 100 paise). See CLAUDE.md §8.
 * Floats are never used for arithmetic; formatting happens only at display time.
 */

/** An amount in integer paise. A plain number alias, so it works with JSON and Prisma `Int`. */
export type Paise = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Throws unless `value` is a non-negative safe integer. */
export function assertPaise(value: number, label = 'amount'): asserts value is Paise {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(`${label} must be a non-negative integer number of paise, got ${value}`);
  }
}

const RUPEE_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a rupee amount written as a decimal string ("399", "399.5", "399.50") into paise,
 * without going through floating point. Rejects negatives, exponents, more than 2 decimals
 * and anything that is not a plain number.
 */
export function rupeesToPaise(rupees: string): Paise {
  const match = RUPEE_PATTERN.exec(rupees.trim());
  if (!match) {
    throw new MoneyError(`Invalid rupee amount: "${rupees}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const paise = Number(whole) * 100 + Number(fraction);
  assertPaise(paise);
  return paise;
}

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Formats paise for display in Indian style: 39900 → "₹399", 39950 → "₹399.50",
 * 12345600 → "₹1,23,456". Supports negative amounts (e.g. ledger debits).
 */
export function formatINR(paise: Paise): string {
  if (!Number.isSafeInteger(paise)) {
    throw new MoneyError(`formatINR expects integer paise, got ${paise}`);
  }
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const rest = abs % 100;
  // Intl groups the integer rupees (BigInt, no float); paise are appended exactly.
  // en-IN always uses "." as the decimal separator.
  const whole = inrWhole.format(BigInt(rupees));
  return rest === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(rest).padStart(2, '0')}`;
}
