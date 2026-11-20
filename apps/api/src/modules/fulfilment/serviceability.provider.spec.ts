import { describe, expect, it } from 'vitest';
import {
  parseShiprocketServiceability,
  ShiprocketServiceabilityProvider,
  shiprocketWeightKg,
  StubServiceabilityProvider,
} from './serviceability.provider.js';
import type { ShiprocketClient } from './shiprocket.client.js';
import { ShiprocketError } from './shiprocket.client.js';
import {
  emptyCouriersBody,
  noCodBody,
  notServiceableBody,
  serviceableBody,
} from './shiprocket.fixtures.js';

describe('parseShiprocketServiceability', () => {
  it('reads couriers: delivery-day range, COD if any courier collects cash, city/state', () => {
    expect(parseShiprocketServiceability(200, serviceableBody)).toEqual({
      serviceable: true,
      codAvailable: true,
      minDays: 3, // the blocked 1-day courier is ignored
      maxDays: 5,
      city: 'Mumbai',
      state: 'Maharashtra',
    });
  });

  it('reports no COD when no courier collects cash', () => {
    expect(parseShiprocketServiceability(200, noCodBody)).toMatchObject({
      serviceable: true,
      codAvailable: false,
      minDays: 7,
      maxDays: 9,
    });
  });

  it('treats a 404 (in the HTTP status or the body) and empty courier lists as not serviceable', () => {
    const notServiceable = {
      serviceable: false,
      codAvailable: false,
      minDays: null,
      maxDays: null,
    };
    expect(parseShiprocketServiceability(404, notServiceableBody)).toMatchObject(notServiceable);
    expect(parseShiprocketServiceability(200, notServiceableBody)).toMatchObject(notServiceable);
    expect(parseShiprocketServiceability(200, emptyCouriersBody)).toMatchObject(notServiceable);
    expect(
      parseShiprocketServiceability(422, { message: 'Invalid delivery postcode' }),
    ).toMatchObject(notServiceable);
  });

  it('keeps serviceable with an unknown estimate when days are missing', () => {
    const body = {
      data: { available_courier_companies: [{ cod: 1, estimated_delivery_days: '' }] },
    };
    expect(parseShiprocketServiceability(200, body)).toMatchObject({
      serviceable: true,
      minDays: null,
      maxDays: null,
    });
  });

  it('throws on other errors and unreadable bodies', () => {
    expect(() => parseShiprocketServiceability(400, { message: 'Bad request' })).toThrow(
      ShiprocketError,
    );
    expect(() => parseShiprocketServiceability(200, 'not json')).toThrow(ShiprocketError);
  });
});

describe('shiprocketWeightKg', () => {
  it('converts grams to kg with the 0.5 kg minimum', () => {
    expect(shiprocketWeightKg(150)).toBe('0.50');
    expect(shiprocketWeightKg(1000)).toBe('1.00');
    expect(shiprocketWeightKg(1250)).toBe('1.25');
  });
});

describe('ShiprocketServiceabilityProvider', () => {
  it('queries from the pickup PIN with the parcel weight', async () => {
    const calls: { path: string; query: Record<string, string> }[] = [];
    const client = {
      get: async (path: string, query: Record<string, string>) => {
        calls.push({ path, query });
        return { status: 200, body: serviceableBody };
      },
    } as unknown as ShiprocketClient;
    const result = await new ShiprocketServiceabilityProvider(client, '400070').check({
      pincode: '560034',
      weightGrams: 1000,
    });
    expect(result.serviceable).toBe(true);
    expect(calls).toEqual([
      {
        path: '/courier/serviceability/',
        query: { pickup_postcode: '400070', delivery_postcode: '560034', weight: '1.00', cod: '0' },
      },
    ]);
  });
});

describe('StubServiceabilityProvider', () => {
  const stub = new StubServiceabilityProvider();
  const check = (pincode: string) => stub.check({ pincode, weightGrams: 500 });

  it('covers every storefront state', async () => {
    expect(await check('744101')).toMatchObject({ serviceable: false });
    expect(await check('793001')).toMatchObject({
      serviceable: true,
      codAvailable: false,
      minDays: 6,
    });
    expect(await check('400001')).toMatchObject({
      serviceable: true,
      codAvailable: true,
      minDays: 2,
      maxDays: 3,
    });
    expect(await check('302001')).toMatchObject({
      serviceable: true,
      codAvailable: true,
      minDays: 3,
      maxDays: 5,
    });
  });
});
