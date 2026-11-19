import { Module } from '@nestjs/common';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Module({
  imports: [PricingModule],
  controllers: [CartController],
  providers: [CartService, RateLimiterService],
  exports: [CartService],
})
export class CartModule {}
