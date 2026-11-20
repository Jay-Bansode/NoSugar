import {
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ErrorCode, errorResponseSchema } from '@brand/shared';
import { describe, expect, it } from 'vitest';
import { AppException } from './app.exception.js';
import { toErrorResponse } from './http-exception.filter.js';

describe('toErrorResponse', () => {
  it('maps AppException with its code, status and details', () => {
    const result = toErrorResponse(
      new AppException(ErrorCode.OUT_OF_STOCK, 'Sold out', HttpStatus.CONFLICT, { sku: 'X' }),
    );
    expect(result).toEqual({
      status: 409,
      body: { error: { code: 'OUT_OF_STOCK', message: 'Sold out', details: { sku: 'X' } } },
    });
  });

  it('maps Nest HTTP exceptions by status', () => {
    const result = toErrorResponse(new NotFoundException('No such product'));
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(result.body.error.message).toBe('No such product');
  });

  it('hides messages on 5xx HTTP exceptions', () => {
    const result = toErrorResponse(new InternalServerErrorException('db host 10.0.0.5 down'));
    expect(result.status).toBe(500);
    expect(result.body.error).toEqual({
      code: ErrorCode.INTERNAL,
      message: 'Internal server error',
      details: {},
    });
  });

  it('maps 503 to SERVICE_UNAVAILABLE with a generic message', () => {
    const result = toErrorResponse(new ServiceUnavailableException('db host 10.0.0.5 down'));
    expect(result.status).toBe(503);
    expect(result.body.error).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Service unavailable',
      details: {},
    });
  });

  it('turns unknown errors into a generic 500', () => {
    const result = toErrorResponse(new Error('secret stack detail'));
    expect(result.status).toBe(500);
    expect(result.body.error.message).toBe('Internal server error');
  });

  it('always produces a body matching the shared schema', () => {
    for (const err of [new Error('x'), new NotFoundException(), 'a string']) {
      expect(() => errorResponseSchema.parse(toErrorResponse(err).body)).not.toThrow();
    }
  });
});
