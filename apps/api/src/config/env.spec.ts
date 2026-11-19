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

  it('refuses the console OTP provider in production', () => {
    const { message } = errorFrom(() => loadEnv({ ...valid, NODE_ENV: 'production' }));
    expect(message).toContain('OTP_PROVIDER');
  });
});
