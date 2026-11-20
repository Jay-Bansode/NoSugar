import type { NestExpressApplication } from '@nestjs/platform-express';
import { ADMIN_CLIENT_HEADER } from '@brand/shared';
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
  // Browsers may call the API with credentials only from the admin panel. Apps and servers
  // aren't affected by CORS; the storefront's origin is added when the website exists.
  if (env.ADMIN_URL) {
    app.enableCors({
      origin: [new URL(env.ADMIN_URL).origin],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', ADMIN_CLIENT_HEADER],
      exposedHeaders: ['Content-Disposition'],
      maxAge: 600,
    });
  }
  app.enableShutdownHooks();
  return app;
}
