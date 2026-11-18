import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ErrorCode, type ErrorResponse } from '@brand/shared';
import type { Response } from 'express';
import { AppException } from './app.exception.js';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

/** Converts any thrown error into the API error shape from CLAUDE.md §7. */
export function toErrorResponse(exception: unknown): { status: number; body: ErrorResponse } {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      body: {
        error: { code: exception.code, message: exception.message, details: exception.details },
      },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code =
      STATUS_TO_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL : ErrorCode.BAD_REQUEST);
    // Never leak internals on 5xx.
    const message = status >= 500 ? 'Internal server error' : exception.message;
    return { status, body: { error: { code, message, details: {} } } };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { error: { code: ErrorCode.INTERNAL, message: 'Internal server error', details: {} } },
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = toErrorResponse(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}
