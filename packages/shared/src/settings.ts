import { z } from 'zod';

/**
 * Business settings editable in admin (CLAUDE.md §1, §8: never hard-code fees or thresholds).
 * Stored in the `settings` table as key → JSON value; these are the defaults the seed writes.
 */
export const settingsSchema = z.object({
  /** Orders at or above this subtotal ship free. */
  'shipping.free_threshold_paise': z.number().int().nonnegative(),
  /** Shipping fee below the free-shipping threshold. */
  'shipping.flat_fee_paise': z.number().int().nonnegative(),
  /** Cash on Delivery fee (non-refundable). */
  'cod.fee_paise': z.number().int().nonnegative(),
  'cod.enabled': z.boolean(),
  /** Unpaid prepaid orders release reserved stock after this many minutes. */
  'checkout.reservation_minutes': z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  /** Trial kit cashback (Phase 3 uses these). */
  'trial.credit_paise': z.number().int().nonnegative(),
  'trial.credit_validity_days': z.number().int().positive(),
  'trial.refund_window_hours': z.number().int().positive(),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  'shipping.free_threshold_paise': 39900,
  'shipping.flat_fee_paise': 9900,
  'cod.fee_paise': 4900,
  'cod.enabled': true,
  'checkout.reservation_minutes': 30,
  'trial.credit_paise': 39900,
  'trial.credit_validity_days': 30,
  'trial.refund_window_hours': 48,
};
