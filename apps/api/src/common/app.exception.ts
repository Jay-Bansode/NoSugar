import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@brand/shared';

/**
 * Throw this from services for any expected failure. The global filter turns it into
 * `{ error: { code, message, details } }` with the given HTTP status.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message, status);
  }
}
