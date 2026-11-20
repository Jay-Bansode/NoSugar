import { buildInvoiceLines, creditNoteLines, sumLines, taxFromInclusive } from '@brand/shared';
import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatRate,
  renderTaxDocument,
  type TaxDocumentView,
} from './tax-document-pdf.js';

const items = [
  {
    productName: 'Hazel Almond Latte',
    variantName: '15 sachets',
    hsnCode: '2101',
    gstRateBps: 500,
    quantity: 2,
    lineTotalPaise: 139800,
    discountPaise: 0,
    taxPaise: taxFromInclusive(139800, 500),
  },
];

function view(over: Partial<TaxDocumentView> = {}): TaxDocumentView {
  const placeOfSupply = over.placeOfSupply ?? { code: '27', name: 'Maharashtra' };
  const lines = buildInvoiceLines({
    items,
    shippingPaise: 0,
    codFeePaise: 4900,
    taxPaise: items[0]!.taxPaise + taxFromInclusive(4900, 500),
    sellerStateCode: '27',
    placeOfSupplyCode: placeOfSupply.code,
  });
  return {
    kind: 'invoice',
    number: 'INV/26-27/000042',
    issuedAt: new Date('2026-11-20T06:00:00Z'),
    seller: {
      legalName: 'Brand Foods Private Limited',
      address: 'Unit 4, Example Industrial Estate, Pune, Maharashtra 411001',
      gstin: '27ABCDE1234F1Z5',
      stateCode: '27',
      fssaiLicenceNo: '12345678901234',
    },
    buyer: { name: 'Asha Rao', lines: ['12 MG Road', 'Pune, Maharashtra 411001'] },
    placeOfSupply,
    orderNumber: 'BR1000123',
    orderDate: new Date('2026-11-20T05:59:00Z'),
    lines,
    totals: sumLines(lines),
    payment: { method: 'cod', walletPaise: 0 },
    specimen: false,
    ...over,
  };
}

const text = (pdf: Buffer) => pdf.toString('latin1');

describe('formatAmount / formatRate', () => {
  it('uses Indian grouping and two decimals', () => {
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(69900)).toBe('699.00');
    expect(formatAmount(12345678)).toBe('1,23,456.78');
    expect(formatAmount(1000000000)).toBe('1,00,00,000.00');
  });

  it('prints GST rates', () => {
    expect(formatRate(500)).toBe('5%');
    expect(formatRate(1800)).toBe('18%');
    expect(formatRate(1250)).toBe('12.5%');
    expect(formatRate(25)).toBe('0.25%');
    expect(formatRate(0)).toBe('0%');
  });
});

describe('renderTaxDocument', () => {
  it('prints the GST invoice particulars (CGST + SGST within the state)', () => {
    const out = text(renderTaxDocument(view()));
    expect(out.startsWith('%PDF-1.4')).toBe(true);
    for (const s of [
      'TAX INVOICE',
      'INV/26-27/000042',
      '20 Nov 2026',
      'GSTIN: 27ABCDE1234F1Z5',
      'FSSAI Lic. No.: 12345678901234',
      String.raw`Maharashtra \(27\)`,
      'Reverse charge',
      'Asha Rao',
      'BR1000123',
      'Hazel Almond Latte - 15 sachets',
      '(2101)',
      '(CGST)',
      '(SGST)',
      'Cash on delivery fee',
      '1,447.00', // 1398 + 49
      'Rupees One Thousand Four Hundred Forty-Seven Only',
      String.raw`Payable on delivery \(cash\): Rs. 1,447.00`,
      'Authorised signatory',
    ]) {
      expect(out).toContain(s);
    }
    expect(out).not.toContain('(IGST)');
    expect(out).not.toContain('SPECIMEN');
  });

  it('prints IGST to another state, wallet payments and the specimen stamp', () => {
    const out = text(
      renderTaxDocument(
        view({
          placeOfSupply: { code: '29', name: 'Karnataka' },
          payment: { method: 'prepaid', walletPaise: 39900 },
          specimen: true,
        }),
      ),
    );
    expect(out).toContain('(IGST)');
    expect(out).not.toContain('(CGST)');
    expect(out).toContain('Paid with wallet credit: Rs. 399.00');
    expect(out).toContain('Paid online: Rs. 1,048.00');
    expect(out).toContain('SPECIMEN');
  });

  it('prints a credit note against its invoice', () => {
    const base = view();
    const lines = creditNoteLines(base.lines, [], 50000);
    const out = text(
      renderTaxDocument({
        ...base,
        kind: 'credit_note',
        number: 'CN/26-27/000007',
        lines,
        totals: sumLines(lines),
        payment: undefined,
        against: {
          invoiceNumber: 'INV/26-27/000042',
          invoiceDate: new Date('2026-11-20T06:00:00Z'),
          reason: 'Order cancelled (Cancelled by customer)',
        },
      }),
    );
    expect(out).toContain('CREDIT NOTE');
    expect(out).toContain('CN/26-27/000007');
    expect(out).toContain('Against invoice');
    expect(out).toContain(String.raw`Reason: Order cancelled \(Cancelled by customer\)`);
    expect(out).toContain(String.raw`Credit note total \(Rs.\)`);
    expect(out).toContain('500.00');
  });

  it('continues on a new page when there are many lines', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...view().lines[0]!,
      description: `Line ${i}`,
    }));
    const out = text(renderTaxDocument(view({ lines: many, totals: sumLines(many) })));
    expect(out).toMatch(/\/Count [2-9]/);
    expect(out).toContain('(Line 59)');
  });
});
