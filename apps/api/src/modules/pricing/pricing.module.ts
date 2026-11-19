import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service.js';

/**
 * No controller: prices reach customers through the cart and checkout responses, and a
 * standalone quote endpoint would make discount codes easy to probe.
 */
@Module({
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
