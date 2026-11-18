import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import type { z } from 'zod';
import { AppException } from './app.exception.js';

/**
 * Validates a request body/query against a Zod schema from @brand/shared.
 * Usage: `@Body(new ZodValidationPipe(createThingSchema)) body: CreateThing`
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        },
      );
    }
    return result.data;
  }
}
