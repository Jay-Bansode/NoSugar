import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common';
import { type OrderDetail, type VerifyPayment, verifyPaymentSchema } from '@brand/shared';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentAuth } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/token.service.js';
import { PaymentsService } from './payments.service.js';

const VERIFY_LIMIT = { name: 'payments:verify', limit: 20, windowSeconds: 10 * 60 };

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /** Called by the client after Razorpay Checkout succeeds. Returns the updated order. */
  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async verify(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(verifyPaymentSchema)) body: VerifyPayment,
  ): Promise<OrderDetail> {
    await this.rateLimiter.consume(VERIFY_LIMIT, auth.userId);
    return this.payments.verify(auth.userId, body);
  }
}
