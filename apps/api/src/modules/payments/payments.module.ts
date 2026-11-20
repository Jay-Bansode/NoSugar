import { Module } from '@nestjs/common';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ENV, type Env } from '../../config/env.js';
import { InvoicingModule } from '../invoicing/invoicing.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { FakeGateway } from './fake.gateway.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from './gateway.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayGateway } from './razorpay.gateway.js';

function gateway(env: Env): PaymentGateway {
  if (env.PAYMENT_PROVIDER === 'fake') return new FakeGateway();
  // Env validation guarantees these are set for "razorpay".
  return new RazorpayGateway({
    baseUrl: env.RAZORPAY_API_BASE,
    keyId: env.RAZORPAY_KEY_ID!,
    keySecret: env.RAZORPAY_KEY_SECRET!,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET!,
  });
}

@Module({
  imports: [OrdersModule, InvoicingModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    RateLimiterService,
    { provide: PAYMENT_GATEWAY, useFactory: gateway, inject: [ENV] },
  ],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class PaymentsModule {}
