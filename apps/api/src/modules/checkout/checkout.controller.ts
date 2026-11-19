import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  type CheckoutRequest,
  checkoutSchema,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  type OrderDetail,
} from '@brand/shared';
import type { Request, Response } from 'express';
import { AppException } from '../../common/app.exception.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentAuth } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/token.service.js';
import { CheckoutService } from './checkout.service.js';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /**
   * Places an order from the customer's cart. Requires an `Idempotency-Key` (UUID): retrying
   * with the same key returns the same order with 200 and `Idempotent-Replayed: true`.
   */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Headers(IDEMPOTENCY_KEY_HEADER) rawKey: string | undefined,
    @Body(new ZodValidationPipe(checkoutSchema)) body: CheckoutRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderDetail> {
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'An Idempotency-Key header (UUID) is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await this.checkout.checkout(
      auth.userId,
      key.data,
      body,
      req.ip ?? req.socket.remoteAddress ?? 'unknown',
    );
    res.setHeader('Cache-Control', 'no-store');
    if (result.replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return result.order;
  }
}
