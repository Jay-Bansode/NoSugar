import { z } from 'zod';

/** Indian PIN code: 6 digits, not starting with 0. */
export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code');

export const serviceabilityQuerySchema = z.object({ pincode: pincodeSchema });
export type ServiceabilityQuery = z.infer<typeof serviceabilityQuerySchema>;

export const serviceabilitySchema = z.object({
  pincode: z.string(),
  serviceable: z.boolean(),
  /** False when no courier collects cash there, or COD is switched off in settings. */
  codAvailable: z.boolean(),
  /** Days from order to delivery, including dispatch; null when not serviceable. */
  estimatedDelivery: z.object({ minDays: z.number().int(), maxDays: z.number().int() }).nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
});
export type Serviceability = z.infer<typeof serviceabilitySchema>;
