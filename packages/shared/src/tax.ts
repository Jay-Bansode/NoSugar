/**
 * GST helpers. Prices are tax-inclusive (MRP style), so tax is computed back out of the
 * inclusive price. Rates are in basis points (5% = 500 bps). See CLAUDE.md §8.
 *
 * Rounding: half-up to the nearest paisa. Final policy to be confirmed with the CA.
 */
import { assertPaise, MoneyError, type Paise } from './money.js';

const BPS_PER_UNIT = 10_000;
/** Sanity cap (100%). The highest GST slab is far lower; this only rejects garbage input. */
const MAX_GST_BPS = 10_000;

function assertRate(gstRateBps: number): void {
  if (!Number.isInteger(gstRateBps) || gstRateBps < 0 || gstRateBps > MAX_GST_BPS) {
    throw new MoneyError(`gstRateBps must be an integer between 0 and ${MAX_GST_BPS}`);
  }
}

/** Integer division of non-negative integers, rounding half up. */
function divRoundHalfUp(numerator: number, denominator: number): number {
  const scaled = numerator * 2 + denominator;
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyError('Amount too large for exact tax calculation');
  }
  return Math.floor(scaled / (denominator * 2));
}

/**
 * The GST contained in a tax-inclusive price.
 * tax = inclusive × rate / (1 + rate), e.g. ₹399 at 5% → 1900 paise (₹19.00).
 */
export function taxFromInclusive(inclusivePaise: Paise, gstRateBps: number): Paise {
  assertPaise(inclusivePaise, 'inclusivePaise');
  assertRate(gstRateBps);
  if (gstRateBps === 0) return 0;
  return divRoundHalfUp(inclusivePaise * gstRateBps, BPS_PER_UNIT + gstRateBps);
}

/** Tax for an order line, computed on the line total (not per unit) to avoid rounding drift. */
export function lineTax(unitPricePaise: Paise, quantity: number, gstRateBps: number): Paise {
  assertPaise(unitPricePaise, 'unitPricePaise');
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new MoneyError(`quantity must be a positive integer, got ${quantity}`);
  }
  return taxFromInclusive(unitPricePaise * quantity, gstRateBps);
}

export type GstSplit =
  { kind: 'intra'; cgstPaise: Paise; sgstPaise: Paise } | { kind: 'inter'; igstPaise: Paise };

/**
 * Splits a tax amount for the invoice: CGST + SGST when the delivery state equals the
 * seller's state, otherwise IGST. State codes are GST state codes (e.g. "27" Maharashtra).
 * An odd paisa goes to SGST so the parts always sum to the total.
 */
export function splitGst(
  taxPaise: Paise,
  sellerStateCode: string,
  deliveryStateCode: string,
): GstSplit {
  assertPaise(taxPaise, 'taxPaise');
  if (!sellerStateCode || !deliveryStateCode) {
    throw new MoneyError('Both seller and delivery state codes are required');
  }
  if (sellerStateCode === deliveryStateCode) {
    const cgstPaise = Math.floor(taxPaise / 2);
    return { kind: 'intra', cgstPaise, sgstPaise: taxPaise - cgstPaise };
  }
  return { kind: 'inter', igstPaise: taxPaise };
}
