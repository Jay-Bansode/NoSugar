import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

/** Shared app configuration, used by main.ts and the e2e tests so they behave the same. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  // Don't advertise the server framework (OWASP: information disclosure).
  app.disable('x-powered-by');
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  return app;
}
