import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://brand:brand@localhost:5432/brand',
  REDIS_URL: 'redis://localhost:6379',
};

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
    expect(loadEnv(valid)).toEqual({ ...valid, PORT: 3000, APP_VERSION: '0.0.0' });
  });

  it('coerces PORT', () => {
    expect(loadEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('names every missing variable', () => {
    const { message } = errorFrom(() => loadEnv({ NODE_ENV: 'test' }));
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
  });

  it('rejects a non-Postgres DATABASE_URL without echoing the value', () => {
    const { message } = errorFrom(() =>
      loadEnv({ ...valid, DATABASE_URL: 'mysql://user:s3cret@db/app' }),
    );
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('s3cret');
  });
});
