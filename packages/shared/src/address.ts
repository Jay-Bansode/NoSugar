import { z } from 'zod';
import { phoneSchema } from './phone.js';
import { pincodeSchema } from './shipping.js';

/**
 * States and union territories with their GST state codes. The code on the delivery address
 * decides CGST + SGST (same state as the seller) or IGST (CLAUDE.md §8).
 */
export const INDIAN_STATES = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
] as const;

export type StateCode = (typeof INDIAN_STATES)[number]['code'];
const STATE_CODES = INDIAN_STATES.map((s) => s.code) as [StateCode, ...StateCode[]];
export const stateCodeSchema = z.enum(STATE_CODES);

export function stateName(code: string): string | null {
  return INDIAN_STATES.find((s) => s.code === code)?.name ?? null;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish()
    .transform((v) => v ?? null);

/** Delivery address as entered at checkout. */
export const addressInputSchema = z.strictObject({
  name: text(100),
  phone: phoneSchema,
  line1: text(200),
  line2: optionalText(200),
  landmark: optionalText(100),
  city: text(100),
  stateCode: stateCodeSchema,
  pincode: pincodeSchema,
});
export type AddressInput = z.infer<typeof addressInputSchema>;

/** The address as snapshotted onto an order (state name resolved from the code). */
export const shippingAddressSchema = addressInputSchema.extend({
  line2: z.string().nullable(),
  landmark: z.string().nullable(),
  state: z.string(),
});
export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export function toShippingAddress(input: AddressInput): ShippingAddress {
  return { ...input, state: stateName(input.stateCode)! };
}
