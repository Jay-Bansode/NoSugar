import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeIndianMobile, phoneSchema } from './phone.js';

describe('normalizeIndianMobile', () => {
  it.each([
    '9876543210',
    '98765 43210',
    '098765-43210',
    '+91 98765 43210',
    '+919876543210',
    '919876543210',
    '00919876543210',
    '(+91) 98765.43210',
  ])('normalises %j to +919876543210', (input) => {
    expect(normalizeIndianMobile(input)).toBe('+919876543210');
  });

  it.each([
    '',
    '12345',
    '5876543210', // must start 6–9
    '98765432101', // 11 digits, no leading 0
    '+19876543210', // not India
    '+91987654321',
    'abcdefghij',
  ])('rejects %j', (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });
});

describe('maskPhone', () => {
  it('keeps country code and last 4 digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });
});

describe('phoneSchema', () => {
  it('outputs E.164', () => {
    expect(phoneSchema.parse(' 98765 43210 ')).toBe('+919876543210');
  });

  it('rejects invalid numbers with a friendly message', () => {
    const result = phoneSchema.safeParse('123');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/10-digit Indian mobile/);
  });
});
