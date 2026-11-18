import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, errorResponseSchema } from './errors.js';
import { cursorQuerySchema, paginated } from './pagination.js';

describe('errorResponseSchema', () => {
  it('accepts the documented error shape', () => {
    const body = { error: { code: ErrorCode.OUT_OF_STOCK, message: 'Sold out', details: {} } };
    expect(errorResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown codes', () => {
    expect(() =>
      errorResponseSchema.parse({ error: { code: 'NOPE', message: '', details: {} } }),
    ).toThrow();
  });
});

describe('cursorQuerySchema', () => {
  it('defaults limit to 20 and coerces strings', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(cursorQuerySchema.parse({ limit: '50', cursor: 'abc' })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
  });

  it('rejects limits outside 1–100', () => {
    expect(() => cursorQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => cursorQuerySchema.parse({ limit: '0' })).toThrow();
  });
});

describe('paginated', () => {
  it('wraps an item schema', () => {
    const schema = paginated(z.object({ id: z.string() }));
    expect(schema.parse({ data: [{ id: 'a' }], nextCursor: null })).toEqual({
      data: [{ id: 'a' }],
      nextCursor: null,
    });
  });
});
