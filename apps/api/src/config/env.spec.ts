import { describe, expect, it } from 'vitest';
import { TEST_ENV } from '../../test/helpers/env.js';
import { EnvValidationError, loadEnv } from './env.js';

const valid = { ...TEST_ENV };

function errorFrom(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvValidationError);
    return err as EnvValidationError;
  }
  return expect.unreachable('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadEnv(valid)).toEqual({
      ...valid,
      PORT: 3000,
      APP_VERSION: '0.0.0',
      TRUST_PROXY: 0,
      OTP_PROVIDER: 'console',
      SHIPPING_PROVIDER: 'stub',
      SHIPROCKET_API_BASE: 'https://apiv2.shiprocket.in/v1/external',
    });
  });

  it('coerces PORT and TRUST_PROXY', () => {
    const env = loadEnv({ ...valid, PORT: '8080', TRUST_PROXY: '1' });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(1);
  });

  it('names every missing variable', () => {
    const { message } = errorFrom(() => loadEnv({ NODE_ENV: 'test' }));
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'OTP_SECRET']) {
      expect(message).toContain(name);
    }
  });

  it('rejects a non-Postgres DATABASE_URL without echoing the value', () => {
    const { message } = errorFrom(() =>
      loadEnv({ ...valid, DATABASE_URL: 'mysql://user:s3cret@db/app' }),
    );
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('s3cret');
  });

  it('rejects short secrets without echoing them', () => {
    const { message } = errorFrom(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short-secret' }));
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).not.toContain('short-secret');
  });

  it('rejects reused secrets', () => {
    const { message } = errorFrom(() => loadEnv({ ...valid, OTP_SECRET: valid.JWT_ACCESS_SECRET }));
    expect(message).toContain('must all be different');
  });

  it('refuses the console OTP provider and stub shipping in production', () => {
    const { message } = errorFrom(() => loadEnv({ ...valid, NODE_ENV: 'production' }));
    expect(message).toContain('OTP_PROVIDER');
    expect(message).toContain('SHIPPING_PROVIDER');
  });

  it('requires Shiprocket credentials and pickup PIN when using Shiprocket', () => {
    const { message } = errorFrom(() => loadEnv({ ...valid, SHIPPING_PROVIDER: 'shiprocket' }));
    for (const name of [
      'SHIPROCKET_API_EMAIL',
      'SHIPROCKET_API_PASSWORD',
      'SHIPROCKET_PICKUP_PINCODE',
    ]) {
      expect(message).toContain(name);
    }
    const env = loadEnv({
      ...valid,
      SHIPPING_PROVIDER: 'shiprocket',
      SHIPROCKET_API_EMAIL: 'api@example.com',
      SHIPROCKET_API_PASSWORD: 'pw',
      SHIPROCKET_PICKUP_PINCODE: '400001',
    });
    expect(env.SHIPPING_PROVIDER).toBe('shiprocket');
  });
});
