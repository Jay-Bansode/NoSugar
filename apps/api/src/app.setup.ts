import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { ENV, type Env } from './config/env.js';

/** Shared app configuration, used by main.ts and the e2e tests so they behave the same. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const env = app.get<Env>(ENV);
  // Don't advertise the server framework (OWASP: information disclosure).
  app.disable('x-powered-by');
  // req.ip (used for rate limits) comes from X-Forwarded-For only behind trusted proxies.
  app.set('trust proxy', env.TRUST_PROXY);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  return app;
}
