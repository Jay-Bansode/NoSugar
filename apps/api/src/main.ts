import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvValidationError, loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  // Local development: read apps/api/.env if present. Production uses real env vars.
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bufferLogs: true,
  });
  configureApp(app);
  await app.listen(env.PORT);
}

bootstrap().catch((err: unknown) => {
  // The logger may not be up yet, so print the problem plainly and exit.
  // eslint-disable-next-line no-console -- startup failure before the logger exists
  console.error(err instanceof EnvValidationError ? err.message : err);
  process.exit(1);
});
