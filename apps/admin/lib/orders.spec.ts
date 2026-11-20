import { ORDER_STATUSES } from '@brand/shared';
import { describe, expect, it } from 'vitest';
import { readRefundForm } from '@/components/orders/refund-dialog';
import { money, parseRupees, pdfName, STATUS_LABEL, statusVariant } from './orders';

describe('order display helpers', () => {
  it('labels every status', () => {
    for (const status of ORDER_STATUSES) {
      expect(STATUS_LABEL[status]).toBeTruthy();
      expect(['default', 'secondary', 'destructive', 'outline']).toContain(statusVariant(status));
    }
  });

  it('parses rupee amounts into paise without floats', () => {
    expect(parseRupees('699')).toBe(69900);
    expect(parseRupees('₹1,234.50')).toBe(123450);
    expect(parseRupees(' 0.05 ')).toBe(5);
    expect(parseRupees('12.345')).toBeNull();
    expect(parseRupees('-5')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
  });

  it('formats money and file names', () => {
    expect(money(69900)).toBe('₹699');
    expect(pdfName('CN/26-27/000007')).toBe('CN-26-27-000007.pdf');
  });
});

describe('readRefundForm', () => {
  const base = {
    amount: '200',
    reason: 'One pack damaged',
    method: 'razorpay' as const,
    reference: '',
  };

  it('builds the request in paise', () => {
    expect(readRefundForm(base, 69900)).toEqual({
      ok: true,
      body: { amountPaise: 20000, reason: 'One pack damaged', method: 'razorpay' },
    });
  });

  it('explains what is wrong', () => {
    expect(readRefundForm({ ...base, amount: 'lots' }, 69900)).toMatchObject({
      ok: false,
      message: /rupees/,
    });
    expect(readRefundForm({ ...base, amount: '700' }, 69900)).toMatchObject({
      ok: false,
      message: /At most ₹699/,
    });
    expect(readRefundForm({ ...base, reason: '' }, 69900)).toMatchObject({ ok: false });
    expect(readRefundForm({ ...base, method: 'manual' }, 69900)).toMatchObject({
      ok: false,
      message: /reference/,
    });
    expect(
      readRefundForm({ ...base, method: 'manual', reference: 'UTR123456' }, 69900),
    ).toMatchObject({
      ok: true,
      body: { method: 'manual', reference: 'UTR123456' },
    });
  });
});
