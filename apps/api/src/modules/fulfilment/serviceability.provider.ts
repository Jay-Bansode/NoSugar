import { z } from 'zod';
import { type ShiprocketClient, ShiprocketError } from './shiprocket.client.js';

export interface ServiceabilityRequest {
  pincode: string;
  weightGrams: number;
}

/** What the courier side says, before our own settings (COD switch, dispatch days). */
export interface ServiceabilityResult {
  serviceable: boolean;
  codAvailable: boolean;
  /** Courier transit days from pickup; null when unknown or not serviceable. */
  minDays: number | null;
  maxDays: number | null;
  city: string | null;
  state: string | null;
}

export interface ServiceabilityProvider {
  check(request: ServiceabilityRequest): Promise<ServiceabilityResult>;
}

export const SERVICEABILITY_PROVIDER = Symbol('SERVICEABILITY_PROVIDER');

const NOT_SERVICEABLE: ServiceabilityResult = {
  serviceable: false,
  codAvailable: false,
  minDays: null,
  maxDays: null,
  city: null,
  state: null,
};

/**
 * Development stand-in until the Shiprocket account exists. Deterministic rules so the
 * storefront can show every state:
 *   744xxx (Andaman & Nicobar)  → not serviceable
 *   79xxxx (North-East)         → serviceable, no COD, 6–9 days
 *   metro prefixes 11/40/56/60/70/50 → 2–3 days
 *   anything else                → 3–5 days
 */
export class StubServiceabilityProvider implements ServiceabilityProvider {
  async check({ pincode }: ServiceabilityRequest): Promise<ServiceabilityResult> {
    if (pincode.startsWith('744')) return NOT_SERVICEABLE;
    if (pincode.startsWith('79')) {
      return { ...NOT_SERVICEABLE, serviceable: true, minDays: 6, maxDays: 9 };
    }
    const metro = ['11', '40', '56', '60', '70', '50'].includes(pincode.slice(0, 2));
    return {
      serviceable: true,
      codAvailable: true,
      minDays: metro ? 2 : 3,
      maxDays: metro ? 3 : 5,
      city: null,
      state: null,
    };
  }
}

const flag = z.union([z.number(), z.string(), z.boolean()]).optional();

const courierSchema = z.looseObject({
  estimated_delivery_days: z.union([z.string(), z.number()]).nullish(),
  cod: flag,
  blocked: flag,
  city: z.string().nullish(),
  state: z.string().nullish(),
});

const responseSchema = z.looseObject({
  status: z.number().optional(),
  data: z.looseObject({ available_courier_companies: z.array(courierSchema).nullish() }).nullish(),
});

function truthy(value: z.infer<typeof flag>): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * Reads Shiprocket's GET /courier/serviceability response. Fields are parsed leniently
 * (numbers sometimes arrive as strings). Not serviceable = 404 status or no usable couriers.
 */
export function parseShiprocketServiceability(
  httpStatus: number,
  body: unknown,
): ServiceabilityResult {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ShiprocketError('Unexpected serviceability response from Shiprocket', httpStatus);
  }
  const status = parsed.data.status ?? httpStatus;
  if (httpStatus === 404 || httpStatus === 422 || status === 404 || status === 422) {
    return NOT_SERVICEABLE;
  }
  if (httpStatus >= 400) {
    throw new ShiprocketError(`Shiprocket serviceability failed (${httpStatus})`, httpStatus);
  }

  const couriers = (parsed.data.data?.available_courier_companies ?? []).filter(
    (c) => !truthy(c.blocked),
  );
  if (couriers.length === 0) return NOT_SERVICEABLE;

  const days = couriers
    .map((c) => Number.parseInt(String(c.estimated_delivery_days ?? ''), 10))
    .filter((d) => Number.isInteger(d) && d > 0);
  const first = couriers[0]!;
  return {
    serviceable: true,
    codAvailable: couriers.some((c) => truthy(c.cod)),
    minDays: days.length ? Math.min(...days) : null,
    maxDays: days.length ? Math.max(...days) : null,
    city: first.city ?? null,
    state: first.state ?? null,
  };
}

/** Shiprocket weights are in kg; it bills at least 0.5 kg. */
export function shiprocketWeightKg(weightGrams: number): string {
  return (Math.max(500, Math.ceil(weightGrams)) / 1000).toFixed(2);
}

export class ShiprocketServiceabilityProvider implements ServiceabilityProvider {
  constructor(
    private readonly client: ShiprocketClient,
    private readonly pickupPincode: string,
  ) {}

  async check({ pincode, weightGrams }: ServiceabilityRequest): Promise<ServiceabilityResult> {
    const { status, body } = await this.client.get('/courier/serviceability/', {
      pickup_postcode: this.pickupPincode,
      delivery_postcode: pincode,
      weight: shiprocketWeightKg(weightGrams),
      // Prepaid query; each courier still reports whether it collects cash (`cod`).
      cod: '0',
    });
    return parseShiprocketServiceability(status, body);
  }
}
