import { Module } from '@nestjs/common';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { CartModule } from '../cart/cart.module.js';
import { FulfilmentModule } from '../fulfilment/fulfilment.module.js';
import { InvoicingModule } from '../invoicing/invoicing.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

@Module({
  imports: [
    CartModule,
    PricingModule,
    FulfilmentModule,
    OrdersModule,
    PaymentsModule,
    InvoicingModule,
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService, RateLimiterService],
})
export class CheckoutModule {}
