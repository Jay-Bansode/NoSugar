import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Database integration tests: need a migrated Postgres at DATABASE_URL.
export default defineConfig({
  test: {
    include: ['test/**/*.db-spec.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
