/** Valid environment for tests. Secrets are fixed test-only values. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://brand:brand@localhost:5432/brand',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdefghij',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdefghij',
  OTP_SECRET: 'test-otp-secret-0123456789abcdefghijklm',
} as const;
