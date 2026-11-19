import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { swcPlugin } from './vitest.config.js';

if (!process.env.DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Integration tests: need a migrated Postgres at DATABASE_URL and Redis at REDIS_URL.
export default defineConfig({
  plugins: [swcPlugin],
  test: {
    include: ['test/**/*.db-spec.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
