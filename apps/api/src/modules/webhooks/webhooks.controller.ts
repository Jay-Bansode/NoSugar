import { Controller, Headers, HttpCode, Post, type RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/auth.guard.js';
import { WebhooksService } from './webhooks.service.js';

@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /** Razorpay calls this; authenticity comes from the X-Razorpay-Signature HMAC. */
  @Post('razorpay')
  @HttpCode(200)
  async razorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ): Promise<{ received: true }> {
    await this.webhooks.receiveRazorpay(req.rawBody, signature, eventId);
    return { received: true };
  }
}
