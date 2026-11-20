import { Global, Injectable, Logger, Module } from '@nestjs/common';
import {
  DEFAULT_SETTINGS,
  type PricingFees,
  type SettingKey,
  type Settings,
  settingsSchema,
} from '@brand/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Business settings from the `settings` table (CLAUDE.md §8: fees and thresholds are settings,
 * not code). Missing or invalid rows fall back to the shared defaults, with a warning, so a
 * bad admin edit can never take checkout down.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAll(): Promise<Settings> {
    const rows = await this.prisma.setting.findMany();
    const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const shape = settingsSchema.shape;
    for (const row of rows) {
      if (!(row.key in shape)) continue;
      const key = row.key as SettingKey;
      const parsed = shape[key].safeParse(row.value);
      if (parsed.success) {
        settings[key] = parsed.data;
      } else {
        this.logger.warn(`Invalid value for setting "${key}"; using the default`);
      }
    }
    return settingsSchema.parse(settings);
  }

  async pricingFees(): Promise<PricingFees> {
    const s = await this.getAll();
    return {
      freeShippingThresholdPaise: s['shipping.free_threshold_paise'],
      shippingFeePaise: s['shipping.flat_fee_paise'],
      codFeePaise: s['cod.fee_paise'],
      codEnabled: s['cod.enabled'],
    };
  }
}

@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
