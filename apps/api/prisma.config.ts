import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself. Load apps/api/.env for local CLI use if present.
if (!process.env.DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // `prisma generate` needs no database, so CI/Docker builds work without DATABASE_URL.
  // migrate/seed commands fail with a clear error if it is missing.
  ...(url ? { datasource: { url } } : {}),
});
