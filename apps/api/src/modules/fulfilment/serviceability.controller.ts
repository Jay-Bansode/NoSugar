import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import {
  type Serviceability,
  type ServiceabilityQuery,
  serviceabilityQuerySchema,
} from '@brand/shared';
import type { Request } from 'express';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Public } from '../auth/auth.guard.js';
import { ServiceabilityService } from './serviceability.service.js';

/** Each uncached check costs a Shiprocket API call. */
const PER_IP = { name: 'svc:ip', limit: 60, windowSeconds: 10 * 60 };

@Public()
@Controller('serviceability')
export class ServiceabilityController {
  constructor(
    private readonly serviceability: ServiceabilityService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async check(
    @Query(new ZodValidationPipe(serviceabilityQuerySchema)) query: ServiceabilityQuery,
    @Req() req: Request,
  ): Promise<Serviceability> {
    await this.rateLimiter.consume(PER_IP, req.ip ?? req.socket.remoteAddress ?? 'unknown');
    return this.serviceability.check(query.pincode);
  }
}
