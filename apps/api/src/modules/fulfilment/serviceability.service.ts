import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCode, type Serviceability } from '@brand/shared';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/app.exception.js';
import { REDIS } from '../../redis/redis.module.js';
import { SettingsService } from '../../settings/settings.service.js';
import {
  SERVICEABILITY_PROVIDER,
  type ServiceabilityProvider,
  type ServiceabilityResult,
} from './serviceability.provider.js';

/** Courier coverage rarely changes; cache to save API calls and keep checkout fast. */
export const SERVICEABILITY_CACHE_SECONDS = 6 * 60 * 60;
/** Weight used when no cart is involved (product page PIN check): one parcel. */
export const DEFAULT_PARCEL_GRAMS = 500;
const WEIGHT_BUCKET_GRAMS = 500;

@Injectable()
export class ServiceabilityService {
  private readonly logger = new Logger(ServiceabilityService.name);

  constructor(
    @Inject(SERVICEABILITY_PROVIDER) private readonly provider: ServiceabilityProvider,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Can we deliver to this PIN code, with COD, and how fast? Courier answers are cached;
   * our settings (COD switch, dispatch days) are applied on every call so changes show at once.
   */
  async check(pincode: string, weightGrams = DEFAULT_PARCEL_GRAMS): Promise<Serviceability> {
    const result = await this.courierResult(pincode, weightGrams);
    const settings = await this.settings.getAll();
    const dispatch = settings['shipping.dispatch_days'];
    return {
      pincode,
      serviceable: result.serviceable,
      codAvailable: result.serviceable && result.codAvailable && settings['cod.enabled'],
      estimatedDelivery:
        result.serviceable && result.minDays !== null && result.maxDays !== null
          ? { minDays: result.minDays + dispatch, maxDays: result.maxDays + dispatch }
          : null,
      city: result.city,
      state: result.state,
    };
  }

  private async courierResult(pincode: string, weightGrams: number): Promise<ServiceabilityResult> {
    const bucket = Math.max(1, Math.ceil(weightGrams / WEIGHT_BUCKET_GRAMS)) * WEIGHT_BUCKET_GRAMS;
    const key = `svc:v1:${pincode}:${bucket}`;
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as ServiceabilityResult;
      } catch {
        await this.redis.del(key);
      }
    }

    let result: ServiceabilityResult;
    try {
      result = await this.provider.check({ pincode, weightGrams: bucket });
    } catch (err) {
      this.logger.warn(
        `Serviceability check failed (pincode=${pincode}): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        "We couldn't check delivery right now. Please try again.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // Only real answers are cached, never failures.
    await this.redis.set(key, JSON.stringify(result), 'EX', SERVICEABILITY_CACHE_SECONDS);
    return result;
  }
}
