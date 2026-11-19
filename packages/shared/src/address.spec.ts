import { describe, expect, it } from 'vitest';
import { addressInputSchema, INDIAN_STATES, stateName, toShippingAddress } from './address.js';
import { checkoutSchema, orderNumberSchema } from './orders.js';

const valid = {
  name: 'Asha Rao',
  phone: '98765 43210',
  line1: '12 MG Road',
  city: 'Pune',
  stateCode: '27',
  pincode: '411001',
};

describe('INDIAN_STATES', () => {
  it('has unique two-digit GST codes', () => {
    const codes = INDIAN_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    codes.forEach((c) => expect(c).toMatch(/^\d{2}$/));
    expect(stateName('27')).toBe('Maharashtra');
    expect(stateName('29')).toBe('Karnataka');
    expect(stateName('99')).toBeNull();
  });
});

describe('addressInputSchema', () => {
  it('normalises phone, trims, and turns blank optional fields into null', () => {
    const parsed = addressInputSchema.parse({
      ...valid,
      name: '  Asha Rao ',
      line2: '  ',
      landmark: undefined,
    });
    expect(parsed).toEqual({
      ...valid,
      phone: '+919876543210',
      line2: null,
      landmark: null,
    });
  });

  it.each([
    ['stateCode', '25'], // merged into 26, not valid
    ['pincode', '41100'],
    ['phone', '12345'],
    ['name', '   '],
  ])('rejects a bad %s', (field, value) => {
    expect(addressInputSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(addressInputSchema.safeParse({ ...valid, gstin: 'x' }).success).toBe(false);
  });

  it('resolves the state name for the order snapshot', () => {
    expect(toShippingAddress(addressInputSchema.parse(valid)).state).toBe('Maharashtra');
  });
});

describe('checkoutSchema', () => {
  it('defaults saveAddress to false', () => {
    expect(checkoutSchema.parse({ paymentMethod: 'cod', address: valid }).saveAddress).toBe(false);
  });
});

describe('orderNumberSchema', () => {
  it.each(['BR1000001', 'BR12345678'])('accepts %s', (n) => {
    expect(orderNumberSchema.safeParse(n).success).toBe(true);
  });
  it.each(['br1000001', 'BR123', '1000001', 'BR-1000001'])('rejects %s', (n) => {
    expect(orderNumberSchema.safeParse(n).success).toBe(false);
  });
});
