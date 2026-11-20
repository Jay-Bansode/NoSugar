/**
 * GST invoice and credit note arithmetic (CLAUDE.md §8). Pure functions: the API stores what
 * these return as an immutable snapshot and renders PDFs from it.
 *
 *   - One invoice line per order line, valued after its share of the discount, plus one line
 *     each for shipping and the COD fee (taxed at the order's highest rate, as at checkout).
 *   - CGST + SGST when the place of supply is the seller's state, otherwise IGST; split per line.
 *   - Credit notes reverse part or all of an invoice. Over all credit notes, every amount
 *     (value, taxable value, each tax) adds up to at most the invoice's, and exactly to it
 *     once fully credited.
 *
 * Wallet credit is a way of paying (pending CA confirmation), so it doesn't reduce the
 * invoice: invoice total = order total + wallet amount.
 */
import { assertPaise, MoneyError, type Paise } from './money.js';
import { allocateProportionally } from './pricing.js';
import { splitGst, taxFromInclusive } from './tax.js';

/** PLACEHOLDER prefixes until the CA confirms the format (docs/pending-decisions.md #4). */
export const INVOICE_PREFIX = 'INV';
export const CREDIT_NOTE_PREFIX = 'CN';
/** GST rules cap invoice and credit note numbers at 16 characters. */
export const DOCUMENT_NUMBER_MAX_LENGTH = 16;
const SEQUENCE_DIGITS = 6;
/** India Standard Time is UTC+5:30 all year (no daylight saving). */
const IST_OFFSET_MS = 330 * 60_000;

export class InvoiceError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceError';
  }
}

/** Financial year (April–March, Indian time) containing `at`, e.g. "2026-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Printed number, e.g. ("INV", "2026-27", 123) → "INV/26-27/000123". */
export function documentNumber(prefix: string, fy: string, sequence: number): string {
  if (!/^\d{4}-\d{2}$/.test(fy)) throw new InvoiceError(`Invalid financial year "${fy}"`);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new InvoiceError(`Invalid sequence ${sequence}`);
  }
  const number = `${prefix}/${fy.slice(2)}/${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`;
  if (number.length > DOCUMENT_NUMBER_MAX_LENGTH || !/^[A-Za-z0-9/-]+$/.test(number)) {
    throw new InvoiceError(`Document number "${number}" breaks the GST format rules`);
  }
  return number;
}

export interface TaxAmounts {
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
}

export interface DocumentLine extends TaxAmounts {
  description: string;
  hsnCode: string;
  quantity: number;
  gstRateBps: number;
  /** Tax-inclusive value of the line (after discount). = taxable value + taxes. */
  totalPaise: Paise;
  taxableValuePaise: Paise;
}

export interface CreditNoteLine extends DocumentLine {
  /** Index of the invoice line this reverses. */
  invoiceLine: number;
}

export interface DocumentTotals extends TaxAmounts {
  taxableValuePaise: Paise;
  totalPaise: Paise;
}

export interface InvoiceSourceItem {
  productName: string;
  variantName: string;
  hsnCode: string;
  gstRateBps: number;
  quantity: number;
  lineTotalPaise: Paise;
  discountPaise: Paise;
  taxPaise: Paise;
}

export interface InvoiceSource {
  items: InvoiceSourceItem[];
  shippingPaise: Paise;
  codFeePaise: Paise;
  /** The order's total GST (lines + charges). */
  taxPaise: Paise;
  sellerStateCode: string;
  placeOfSupplyCode: string;
}

function taxLine(
  base: Omit<DocumentLine, keyof TaxAmounts | 'taxableValuePaise'>,
  taxPaise: Paise,
  intraState: boolean,
): DocumentLine {
  if (taxPaise > base.totalPaise) throw new InvoiceError('Line tax exceeds the line value');
  const split = intraState
    ? { cgstPaise: Math.floor(taxPaise / 2), sgstPaise: taxPaise - Math.floor(taxPaise / 2) }
    : { cgstPaise: 0, sgstPaise: 0 };
  return {
    ...base,
    taxableValuePaise: base.totalPaise - taxPaise,
    ...split,
    igstPaise: intraState ? 0 : taxPaise,
  };
}

/** Invoice lines from an order snapshot. Amounts add up exactly to the order's. */
export function buildInvoiceLines(source: InvoiceSource): DocumentLine[] {
  const { items, shippingPaise, codFeePaise, taxPaise } = source;
  if (items.length === 0) throw new InvoiceError('An invoice needs at least one line');
  for (const v of [shippingPaise, codFeePaise, taxPaise]) assertPaise(v);
  // Checks the codes and decides the split the same way as everywhere else.
  const intraState = splitGst(0, source.sellerStateCode, source.placeOfSupplyCode).kind === 'intra';

  const lines = items.map((item) =>
    taxLine(
      {
        description: item.variantName
          ? `${item.productName} - ${item.variantName}`
          : item.productName,
        hsnCode: item.hsnCode,
        quantity: item.quantity,
        gstRateBps: item.gstRateBps,
        totalPaise: item.lineTotalPaise - item.discountPaise,
      },
      item.taxPaise,
      intraState,
    ),
  );

  const chargesPaise = shippingPaise + codFeePaise;
  const chargesTax = taxPaise - items.reduce((sum, i) => sum + i.taxPaise, 0);
  if (chargesTax < 0 || chargesTax > chargesPaise) {
    throw new InvoiceError('Order tax does not match its lines and charges');
  }
  if (chargesPaise > 0) {
    // Charges follow the main supply: the highest-rate line's rate and HSN (pending CA, #24).
    const principal = items.reduce((top, i) => (i.gstRateBps > top.gstRateBps ? i : top));
    const shippingTax =
      codFeePaise === 0
        ? chargesTax
        : Math.min(taxFromInclusive(shippingPaise, principal.gstRateBps), chargesTax);
    const charge = (description: string, totalPaise: Paise, tax: Paise) =>
      taxLine(
        {
          description,
          hsnCode: principal.hsnCode,
          quantity: 1,
          gstRateBps: principal.gstRateBps,
          totalPaise,
        },
        tax,
        intraState,
      );
    if (shippingPaise > 0) lines.push(charge('Shipping charges', shippingPaise, shippingTax));
    if (codFeePaise > 0)
      lines.push(charge('Cash on delivery fee', codFeePaise, chargesTax - shippingTax));
  }
  return lines;
}

export function sumLines(lines: readonly DocumentLine[]): DocumentTotals {
  return lines.reduce<DocumentTotals>(
    (t, l) => ({
      taxableValuePaise: t.taxableValuePaise + l.taxableValuePaise,
      cgstPaise: t.cgstPaise + l.cgstPaise,
      sgstPaise: t.sgstPaise + l.sgstPaise,
      igstPaise: t.igstPaise + l.igstPaise,
      totalPaise: t.totalPaise + l.totalPaise,
    }),
    { taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0 },
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** What is still uncredited on each invoice line. */
export function remainingLines(
  invoiceLines: readonly DocumentLine[],
  creditNotes: readonly (readonly CreditNoteLine[])[],
): DocumentLine[] {
  const remaining = invoiceLines.map((l) => ({ ...l }));
  for (const note of creditNotes) {
    for (const c of note) {
      const r = remaining[c.invoiceLine];
      if (!r) throw new InvoiceError(`Credit note refers to missing invoice line ${c.invoiceLine}`);
      r.totalPaise -= c.totalPaise;
      r.taxableValuePaise -= c.taxableValuePaise;
      r.cgstPaise -= c.cgstPaise;
      r.sgstPaise -= c.sgstPaise;
      r.igstPaise -= c.igstPaise;
    }
  }
  for (const r of remaining) {
    if (
      [r.totalPaise, r.taxableValuePaise, r.cgstPaise, r.sgstPaise, r.igstPaise].some((v) => v < 0)
    ) {
      throw new InvoiceError('Credit notes exceed the invoice');
    }
  }
  return remaining;
}

/**
 * Lines for a credit note of `amountPaise` (tax-inclusive), or of everything still uncredited
 * when `amountPaise` is "remaining". The amount is spread over the lines in proportion to what
 * is left on each; tax is worked back out at each line's rate, and a line credited in full
 * gets exactly its remaining amounts, so rounding never leaves stray paise behind.
 * Returns no lines when nothing is left to credit.
 */
export function creditNoteLines(
  invoiceLines: readonly DocumentLine[],
  previous: readonly (readonly CreditNoteLine[])[],
  amountPaise: Paise | 'remaining',
): CreditNoteLine[] {
  const remaining = remainingLines(invoiceLines, previous);
  const left = remaining.reduce((sum, r) => sum + r.totalPaise, 0);
  const amount = amountPaise === 'remaining' ? left : amountPaise;
  assertPaise(amount, 'amountPaise');
  if (amount > left)
    throw new InvoiceError(`Credit of ${amount} exceeds the ${left} left to credit`);
  if (amount === 0) return [];

  const shares = allocateProportionally(
    amount,
    remaining.map((r) => r.totalPaise),
  );
  const lines: CreditNoteLine[] = [];
  shares.forEach((share, index) => {
    if (share === 0) return;
    const r = remaining[index]!;
    if (share === r.totalPaise) {
      lines.push({ ...r, invoiceLine: index });
      return;
    }
    const remainingTax = r.cgstPaise + r.sgstPaise + r.igstPaise;
    // Keep both the taxable value and the tax within what is left on the line.
    const tax = clamp(
      taxFromInclusive(share, r.gstRateBps),
      Math.max(0, share - r.taxableValuePaise),
      remainingTax,
    );
    const intraState = invoiceLines[index]!.igstPaise === 0;
    const cgst = intraState
      ? clamp(Math.floor(tax / 2), Math.max(0, tax - r.sgstPaise), r.cgstPaise)
      : 0;
    lines.push({
      ...r,
      invoiceLine: index,
      totalPaise: share,
      taxableValuePaise: share - tax,
      cgstPaise: cgst,
      sgstPaise: intraState ? tax - cgst : 0,
      igstPaise: intraState ? 0 : tax,
    });
  });
  return lines;
}
