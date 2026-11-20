import { describe, expect, it } from 'vitest';
import {
  buildInvoiceLines,
  type CreditNoteLine,
  creditNoteLines,
  type DocumentLine,
  documentNumber,
  financialYear,
  type InvoiceSource,
  type InvoiceSourceItem,
  remainingLines,
  sumLines,
} from './invoice.js';
import { taxFromInclusive } from './tax.js';

const item = (over: Partial<InvoiceSourceItem> = {}): InvoiceSourceItem => {
  const base = {
    productName: 'Hazel Almond Latte',
    variantName: '15 sachets',
    hsnCode: '2101',
    gstRateBps: 500,
    quantity: 1,
    lineTotalPaise: 69900,
    discountPaise: 0,
    ...over,
  };
  return {
    ...base,
    taxPaise:
      over.taxPaise ?? taxFromInclusive(base.lineTotalPaise - base.discountPaise, base.gstRateBps),
  };
};

const source = (over: Partial<InvoiceSource> = {}): InvoiceSource => {
  const items = over.items ?? [item()];
  const shippingPaise = over.shippingPaise ?? 0;
  const codFeePaise = over.codFeePaise ?? 0;
  const topRate = Math.max(...items.map((i) => i.gstRateBps));
  return {
    items,
    shippingPaise,
    codFeePaise,
    taxPaise:
      over.taxPaise ??
      items.reduce((s, i) => s + i.taxPaise, 0) +
        taxFromInclusive(shippingPaise + codFeePaise, topRate),
    sellerStateCode: over.sellerStateCode ?? '27',
    placeOfSupplyCode: over.placeOfSupplyCode ?? '27',
  };
};

function expectConsistent(lines: readonly DocumentLine[]): void {
  for (const l of lines) {
    expect(l.totalPaise).toBe(l.taxableValuePaise + l.cgstPaise + l.sgstPaise + l.igstPaise);
    for (const v of [l.taxableValuePaise, l.cgstPaise, l.sgstPaise, l.igstPaise]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(l.igstPaise === 0 || (l.cgstPaise === 0 && l.sgstPaise === 0)).toBe(true);
  }
}

describe('financialYear', () => {
  it('switches on 1 April, Indian time', () => {
    expect(financialYear(new Date('2026-03-31T18:29:59.999Z'))).toBe('2025-26');
    expect(financialYear(new Date('2026-03-31T18:30:00.000Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T18:29:59Z'))).toBe('2026-27');
  });

  it('handles the century turn', () => {
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('2099-00');
  });
});

describe('documentNumber', () => {
  it('formats within the 16-character GST limit', () => {
    expect(documentNumber('INV', '2026-27', 123)).toBe('INV/26-27/000123');
    expect(documentNumber('INV', '2026-27', 999_999)).toHaveLength(16);
    expect(documentNumber('CN', '2026-27', 1)).toBe('CN/26-27/000001');
  });

  it('refuses numbers that would break the rules', () => {
    expect(() => documentNumber('INV', '2026-27', 1_000_000)).toThrow(/GST format/);
    expect(() => documentNumber('IN V', '2026-27', 1)).toThrow(/GST format/);
    expect(() => documentNumber('INV', '2026-27', 0)).toThrow(/sequence/);
    expect(() => documentNumber('INV', '2026-27', 1.5)).toThrow(/sequence/);
    expect(() => documentNumber('INV', '26-27', 1)).toThrow(/financial year/);
  });
});

describe('buildInvoiceLines', () => {
  it('splits CGST + SGST within the seller state (odd paisa to SGST)', () => {
    const [line] = buildInvoiceLines(source());
    // ₹699 at 5%: tax 3329 (₹33.29), taxable 66571.
    expect(line).toEqual({
      description: 'Hazel Almond Latte - 15 sachets',
      hsnCode: '2101',
      quantity: 1,
      gstRateBps: 500,
      totalPaise: 69900,
      taxableValuePaise: 66571,
      cgstPaise: 1664,
      sgstPaise: 1665,
      igstPaise: 0,
    });
  });

  it('charges IGST to another state', () => {
    const [line] = buildInvoiceLines(source({ placeOfSupplyCode: '29' }));
    expect(line).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 3329 });
  });

  it('values lines after their share of the discount', () => {
    const lines = buildInvoiceLines(
      source({ items: [item({ quantity: 2, lineTotalPaise: 139800, discountPaise: 13980 })] }),
    );
    expect(lines[0]).toMatchObject({ quantity: 2, totalPaise: 125820 });
    expect(lines[0]!.cgstPaise + lines[0]!.sgstPaise).toBe(taxFromInclusive(125820, 500));
  });

  it('adds shipping and COD fee at the highest rate, adding up to the order tax', () => {
    const items = [
      item({ lineTotalPaise: 29900 }),
      item({
        productName: 'Tumbler',
        variantName: '',
        hsnCode: '9617',
        gstRateBps: 1800,
        lineTotalPaise: 49900,
      }),
    ];
    const src = source({ items, shippingPaise: 9900, codFeePaise: 4900 });
    const lines = buildInvoiceLines(src);
    expect(lines.map((l) => l.description)).toEqual([
      'Hazel Almond Latte - 15 sachets',
      'Tumbler',
      'Shipping charges',
      'Cash on delivery fee',
    ]);
    expect(lines[2]).toMatchObject({ hsnCode: '9617', gstRateBps: 1800, totalPaise: 9900 });
    expect(lines[3]).toMatchObject({ hsnCode: '9617', gstRateBps: 1800, totalPaise: 4900 });
    const totals = sumLines(lines);
    expect(totals.totalPaise).toBe(29900 + 49900 + 9900 + 4900);
    expect(totals.cgstPaise + totals.sgstPaise + totals.igstPaise).toBe(src.taxPaise);
    expectConsistent(lines);
  });

  it('leaves out charges that are zero', () => {
    expect(buildInvoiceLines(source({ codFeePaise: 4900 })).map((l) => l.description)).toEqual([
      'Hazel Almond Latte - 15 sachets',
      'Cash on delivery fee',
    ]);
  });

  it('refuses an order whose tax does not add up', () => {
    expect(() => buildInvoiceLines(source({ taxPaise: 3000 }))).toThrow(/does not match/);
    expect(() => buildInvoiceLines(source({ shippingPaise: 9900, taxPaise: 3329 + 9901 }))).toThrow(
      /does not match/,
    );
    expect(() => buildInvoiceLines(source({ items: [], taxPaise: 0 }))).toThrow(/at least one/);
    expect(() => buildInvoiceLines(source({ placeOfSupplyCode: '' }))).toThrow(/state codes/);
  });
});

describe('creditNoteLines', () => {
  const invoice = buildInvoiceLines(
    source({
      items: [
        item({ quantity: 2, lineTotalPaise: 139800, discountPaise: 6990 }),
        item({
          productName: 'Tumbler',
          variantName: '',
          hsnCode: '9617',
          gstRateBps: 1800,
          lineTotalPaise: 49900,
          discountPaise: 2495,
        }),
      ],
      shippingPaise: 0,
      codFeePaise: 4900,
    }),
  );
  const invoiceTotal = sumLines(invoice).totalPaise;

  it('credits everything left, matching the invoice exactly', () => {
    const lines = creditNoteLines(invoice, [], 'remaining');
    expect(lines.map(({ invoiceLine: _, ...l }) => l)).toEqual(invoice);
    expect(lines.map((l) => l.invoiceLine)).toEqual([0, 1, 2]);
  });

  it('spreads a partial credit over the lines with a correct GST split', () => {
    const lines = creditNoteLines(invoice, [], 50_000);
    expect(sumLines(lines).totalPaise).toBe(50_000);
    expectConsistent(lines);
    for (const l of lines) {
      const tax = l.cgstPaise + l.sgstPaise + l.igstPaise;
      expect(Math.abs(tax - taxFromInclusive(l.totalPaise, l.gstRateBps))).toBeLessThanOrEqual(1);
      expect(l.cgstPaise === l.sgstPaise || l.sgstPaise === l.cgstPaise + 1).toBe(true);
    }
  });

  it('adds up exactly after partial credits followed by the rest', () => {
    const first = creditNoteLines(invoice, [], 12_345);
    const second = creditNoteLines(invoice, [first], 777);
    const rest = creditNoteLines(invoice, [first, second], 'remaining');
    const credited = sumLines([...first, ...second, ...rest]);
    expect(credited).toEqual(sumLines(invoice));
    expect(remainingLines(invoice, [first, second, rest]).every((l) => l.totalPaise === 0)).toBe(
      true,
    );
    expect(creditNoteLines(invoice, [first, second, rest], 'remaining')).toEqual([]);
  });

  it('works for IGST invoices', () => {
    const inter = buildInvoiceLines(source({ placeOfSupplyCode: '07' }));
    const first = creditNoteLines(inter, [], 10_001);
    expect(first[0]).toMatchObject({ cgstPaise: 0, sgstPaise: 0 });
    expect(first[0]!.igstPaise).toBe(taxFromInclusive(10_001, 500));
    const rest = creditNoteLines(inter, [first], 'remaining');
    expect(sumLines([...first, ...rest])).toEqual(sumLines(inter));
  });

  it('refuses to credit more than is left', () => {
    expect(() => creditNoteLines(invoice, [], invoiceTotal + 1)).toThrow(/exceeds/);
    const half = creditNoteLines(invoice, [], 60_000);
    expect(() => creditNoteLines(invoice, [half], invoiceTotal - 60_000 + 1)).toThrow(/exceeds/);
    expect(() => creditNoteLines(invoice, [], -1)).toThrow();
    expect(() => creditNoteLines(invoice, [], 1.5)).toThrow();
  });

  it('rejects credit notes that point at lines the invoice does not have', () => {
    const bogus: CreditNoteLine[] = [{ ...invoice[0]!, invoiceLine: 9 }];
    expect(() => remainingLines(invoice, [bogus])).toThrow(/missing invoice line/);
    const over: CreditNoteLine[] = [
      { ...invoice[0]!, invoiceLine: 0, totalPaise: invoice[0]!.totalPaise + 1 },
    ];
    expect(() => remainingLines(invoice, [over])).toThrow(/exceed/);
  });

  it('never overshoots any amount over many random partial credits', () => {
    let seed = 42;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let round = 0; round < 200; round++) {
      const lines = buildInvoiceLines(
        source({
          items: [
            item({ lineTotalPaise: 1 + next(200_000) }),
            item({ gstRateBps: 1800, lineTotalPaise: 1 + next(100_000) }),
            item({ gstRateBps: 1200, lineTotalPaise: 1 + next(5_000) }),
          ],
          shippingPaise: next(2) * 9900,
          codFeePaise: next(2) * 4900,
          placeOfSupplyCode: next(2) ? '27' : '29',
        }),
      );
      const notes: CreditNoteLine[][] = [];
      for (let k = 0; k < 4; k++) {
        const left = remainingLines(lines, notes).reduce((s, l) => s + l.totalPaise, 0);
        const note = creditNoteLines(lines, notes, next(left + 1));
        expectConsistent(note);
        notes.push(note);
        remainingLines(lines, notes); // throws if anything went negative
      }
      notes.push(creditNoteLines(lines, notes, 'remaining'));
      expect(sumLines(notes.flat())).toEqual(sumLines(lines));
    }
  });
});
