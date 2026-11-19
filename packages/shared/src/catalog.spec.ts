import { describe, expect, it } from 'vitest';
import { productListQuerySchema, slugSchema } from './catalog.js';

describe('slugSchema', () => {
  it.each(['hazel-almond-latte', 'trial-kit', 'bundle-of-2', 'a'])('accepts %s', (slug) => {
    expect(slugSchema.parse(slug)).toBe(slug);
  });

  it.each([
    '',
    'Upper',
    'double--dash',
    '-leading',
    'trailing-',
    'has space',
    'semi;colon',
    '../x',
  ])('rejects %j', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });
});

describe('productListQuerySchema', () => {
  it('defaults limit and accepts a type filter', () => {
    expect(productListQuerySchema.parse({ type: 'coffee' })).toEqual({ limit: 20, type: 'coffee' });
  });

  it('rejects unknown types and non-uuid cursors', () => {
    expect(productListQuerySchema.safeParse({ type: 'tea' }).success).toBe(false);
    expect(productListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
  });

  it('accepts a uuid cursor', () => {
    const cursor = '01a1f245-e32e-711f-896a-a1ad6a76245e';
    expect(productListQuerySchema.parse({ cursor }).cursor).toBe(cursor);
  });
});
