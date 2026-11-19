import { describe, expect, it } from 'vitest';
import { addCartItemSchema, updateCartSchema } from './cart.js';

const uuid = '01a1f245-e32e-711f-896a-a1ad6a76245e';

describe('addCartItemSchema', () => {
  it('accepts a variant line and defaults quantity to 1', () => {
    expect(addCartItemSchema.parse({ variantId: uuid })).toEqual({ variantId: uuid, quantity: 1 });
  });

  it('accepts a bundle line with a selection', () => {
    const item = { bundleId: uuid, quantity: 2, selection: [uuid, uuid] };
    expect(addCartItemSchema.parse(item)).toEqual(item);
  });

  it.each([
    [{ variantId: uuid, quantity: 0 }],
    [{ variantId: uuid, quantity: 100 }],
    [{ variantId: 'nope' }],
    [{ bundleId: uuid }], // no selection
    [{ bundleId: uuid, selection: [] }],
    [{ variantId: uuid, bundleId: uuid, selection: [uuid] }], // both
    [{ variantId: uuid, extra: true }],
    [{}],
  ])('rejects %j', (item) => {
    expect(addCartItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('updateCartSchema', () => {
  it('trims codes and allows null to remove', () => {
    expect(updateCartSchema.parse({ discountCode: '  save10 ' })).toEqual({
      discountCode: 'save10',
    });
    expect(updateCartSchema.parse({ discountCode: null })).toEqual({ discountCode: null });
  });

  it('rejects empty or long codes', () => {
    expect(updateCartSchema.safeParse({ discountCode: '   ' }).success).toBe(false);
    expect(updateCartSchema.safeParse({ discountCode: 'x'.repeat(41) }).success).toBe(false);
  });
});
