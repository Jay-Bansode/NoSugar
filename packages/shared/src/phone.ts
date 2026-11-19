import { z } from 'zod';

/** Indian mobile numbers: 10 digits starting 6–9. */
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Normalises common ways people type an Indian mobile number to E.164 (+91XXXXXXXXXX).
 * Accepts "98765 43210", "098765-43210", "+91 98765 43210", "919876543210", "0091…".
 * Returns null if it is not a valid Indian mobile number.
 */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return INDIAN_MOBILE.test(digits) ? `+91${digits}` : null;
}

/** For logs and UI hints: "+919876543210" → "+91******3210". Never log full numbers. */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '****';
  return `${e164.slice(0, 3)}${'*'.repeat(e164.length - 7)}${e164.slice(-4)}`;
}

/** Zod schema: accepts user input, outputs E.164. */
export const phoneSchema = z
  .string()
  .max(20)
  .transform((value, ctx) => {
    const normalized = normalizeIndianMobile(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return normalized;
  });
