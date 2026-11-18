import { cursorQuerySchema, ErrorCode } from '@brand/shared';
import { describe, expect, it } from 'vitest';
import { AppException } from './app.exception.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(cursorQuerySchema);

  it('returns parsed (coerced, defaulted) data', () => {
    expect(pipe.transform({ limit: '5' })).toEqual({ limit: 5 });
  });

  it('throws VALIDATION_FAILED with issue paths', () => {
    let caught: unknown;
    try {
      pipe.transform({ limit: '500' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppException);
    const appErr = caught as AppException;
    expect(appErr.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(appErr.getStatus()).toBe(400);
    expect(appErr.details).toMatchObject({ issues: [{ path: 'limit' }] });
  });
});
