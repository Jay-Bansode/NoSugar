/**
 * Pricing engine (CLAUDE.md §1, §6 step 2, §8). Pure and deterministic: same input, same
 * paise. The API is authoritative; clients may reuse this to preview totals.
 *
 * All amounts are integer paise and prices are tax-inclusive. The result always satisfies the
 * orders table CHECK: total = subtotal − discount − wallet + shipping + codFee.
 *
 * Policy defaults pending owner/CA confirmation (docs/pending-decisions.md):
 *   - wallet credit is a payment (tender), not a discount → it does not reduce GST
 *   - GST on shipping and COD fee uses the highest GST rate among the order's lines
 *   - the free-shipping threshold is checked after the discount
 *   - discounts skip lines marked non-discountable (the trial kit)
 *   - wallet credit applies only to lines marked wallet-eligible (standalone 15-sachet packs)
 */
import { assertPaise, MoneyError, type Paise } from './money.js';
import type { PaymentMethod } from './order-status.js';
import { taxFromInclusive } from './tax.js';

export interface PricingLine {
  /** Caller's id for the line (cart item id); echoed back. */
  key: string;
  /** Tax-inclusive unit price. */
  unitPricePaise: Paise;
  quantity: number;
  gstRateBps: number;
  /** False for the trial kit: discount codes don't apply. */
  discountable: boolean;
  /** True only for standalone 15-sachet packs (trial cashback rule). */
  walletEligible: boolean;
}

export interface PricingFees {
  freeShippingThresholdPaise: Paise;
  shippingFeePaise: Paise;
  codFeePaise: Paise;
  codEnabled: boolean;
}

/** A discount already checked as valid for this customer and moment (dates, limits). */
export type PricingDiscount =
  | {
      type: 'percentage';
      valueBps: number;
      maxDiscountPaise: Paise | null;
      minSubtotalPaise: Paise;
    }
  | { type: 'fixed'; valuePaise: Paise; minSubtotalPaise: Paise };

export interface PricingInput {
  lines: PricingLine[];
  fees: PricingFees;
  paymentMethod: PaymentMethod;
  discount?: PricingDiscount | null;
  /** Usable wallet balance (unexpired credit). */
  walletAvailablePaise?: Paise;
}

export interface PricedLine {
  key: string;
  unitPricePaise: Paise;
  quantity: number;
  gstRateBps: number;
  lineTotalPaise: Paise;
  discountPaise: Paise;
  walletPaise: Paise;
  /** GST contained in (lineTotal − discount). */
  taxPaise: Paise;
}

export interface PriceQuote {
  lines: PricedLine[];
  subtotalPaise: Paise;
  discountPaise: Paise;
  walletPaise: Paise;
  shippingPaise: Paise;
  codFeePaise: Paise;
  /** GST on shipping + COD fee (included in taxPaise). */
  chargesTaxPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
  /** 0 once free shipping applies. For "add ₹X more for free shipping" prompts. */
  amountToFreeShippingPaise: Paise;
  /** Set when a discount code was given but its minimum order isn't met. */
  discountBelowMinimum: boolean;
}

export class PricingError extends MoneyError {
  constructor(
    message: string,
    public readonly reason: 'EMPTY' | 'COD_DISABLED' | 'INVALID_LINE' | 'INVALID_DISCOUNT',
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Splits `amount` across `weights` in proportion, in whole paise, summing exactly to `amount`
 * (largest-remainder method; ties go to the earlier line, so results are deterministic).
 * When amount ≤ sum(weights), no part exceeds its weight, so weights can act as caps.
 */
export function allocateProportionally(amount: Paise, weights: Paise[]): Paise[] {
  assertPaise(amount, 'amount');
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (amount === 0 || total === 0) return weights.map(() => 0);

  const shares = weights.map((w, index) => {
    const exact = amount * w;
    if (!Number.isSafeInteger(exact)) throw new MoneyError('Amount too large to allocate exactly');
    return { index, floor: Math.floor(exact / total), remainder: exact % total };
  });
  let left = amount - shares.reduce((sum, s) => sum + s.floor, 0);
  const result = shares.map((s) => s.floor);
  for (const s of [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left === 0) break;
    result[s.index]! += 1;
    left -= 1;
  }
  return result;
}

function discountAmount(discount: PricingDiscount, discountableSubtotal: Paise): Paise {
  if (discount.type === 'percentage') {
    if (
      !Number.isInteger(discount.valueBps) ||
      discount.valueBps < 1 ||
      discount.valueBps > 10_000
    ) {
      throw new PricingError('Percentage discount must be 1–10000 bps', 'INVALID_DISCOUNT');
    }
    const raw = Math.floor((discountableSubtotal * discount.valueBps) / 10_000);
    return discount.maxDiscountPaise === null ? raw : Math.min(raw, discount.maxDiscountPaise);
  }
  assertPaise(discount.valuePaise, 'valuePaise');
  return Math.min(discount.valuePaise, discountableSubtotal);
}

export function priceOrder(input: PricingInput): PriceQuote {
  const { lines, fees, paymentMethod } = input;
  if (lines.length === 0) throw new PricingError('Nothing to price', 'EMPTY');
  if (paymentMethod === 'cod' && !fees.codEnabled) {
    throw new PricingError('Cash on Delivery is not available', 'COD_DISABLED');
  }
  for (const line of lines) {
    assertPaise(line.unitPricePaise, 'unitPricePaise');
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new PricingError(`Invalid quantity for ${line.key}`, 'INVALID_LINE');
    }
  }

  const lineTotals = lines.map((l) => l.unitPricePaise * l.quantity);
  const subtotalPaise = lineTotals.reduce((sum, t) => sum + t, 0);
  assertPaise(subtotalPaise, 'subtotal');

  // Discount: on discountable lines only, then split across them for per-line GST.
  const discountableTotals = lines.map((l, i) => (l.discountable ? lineTotals[i]! : 0));
  const discountableSubtotal = discountableTotals.reduce((sum, t) => sum + t, 0);
  const discount = input.discount ?? null;
  const discountBelowMinimum = discount !== null && subtotalPaise < discount.minSubtotalPaise;
  const discountPaise =
    discount && !discountBelowMinimum ? discountAmount(discount, discountableSubtotal) : 0;
  const lineDiscounts = allocateProportionally(discountPaise, discountableTotals);

  // Wallet: a payment against eligible lines' discounted value, capped by the balance.
  const walletCapacity = lines.map((l, i) =>
    l.walletEligible ? lineTotals[i]! - lineDiscounts[i]! : 0,
  );
  const walletAvailable = input.walletAvailablePaise ?? 0;
  assertPaise(walletAvailable, 'walletAvailablePaise');
  const walletPaise = Math.min(
    walletAvailable,
    walletCapacity.reduce((sum, c) => sum + c, 0),
  );
  const lineWallet = allocateProportionally(walletPaise, walletCapacity);

  // Fees: free-shipping threshold is checked after the discount.
  const netOfDiscount = subtotalPaise - discountPaise;
  const freeShipping = netOfDiscount >= fees.freeShippingThresholdPaise;
  const shippingPaise = freeShipping ? 0 : fees.shippingFeePaise;
  const codFeePaise = paymentMethod === 'cod' ? fees.codFeePaise : 0;

  // GST: per line on (line total − discount); charges at the highest line rate.
  const priced: PricedLine[] = lines.map((l, i) => ({
    key: l.key,
    unitPricePaise: l.unitPricePaise,
    quantity: l.quantity,
    gstRateBps: l.gstRateBps,
    lineTotalPaise: lineTotals[i]!,
    discountPaise: lineDiscounts[i]!,
    walletPaise: lineWallet[i]!,
    taxPaise: taxFromInclusive(lineTotals[i]! - lineDiscounts[i]!, l.gstRateBps),
  }));
  const chargesRate = Math.max(...lines.map((l) => l.gstRateBps));
  const chargesTaxPaise = taxFromInclusive(shippingPaise + codFeePaise, chargesRate);
  const taxPaise = priced.reduce((sum, l) => sum + l.taxPaise, 0) + chargesTaxPaise;

  const totalPaise = subtotalPaise - discountPaise - walletPaise + shippingPaise + codFeePaise;

  return {
    lines: priced,
    subtotalPaise,
    discountPaise,
    walletPaise,
    shippingPaise,
    codFeePaise,
    chargesTaxPaise,
    taxPaise,
    totalPaise,
    amountToFreeShippingPaise: freeShipping ? 0 : fees.freeShippingThresholdPaise - netOfDiscount,
    discountBelowMinimum,
  };
}
