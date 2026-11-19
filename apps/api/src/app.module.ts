import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { ENV, type Env } from './config/env.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';

/** Never log credentials, cookies, OTPs or phone numbers (CLAUDE.md §8). */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.otp',
  '*.phone',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
];

@Global()
@Module({})
class EnvModule {
  static register(env: Env): DynamicModule {
    return { module: EnvModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] };
  }
}

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.register(env),
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
            redact: { paths: REDACT_PATHS, censor: '[redacted]' },
            // Reuse an upstream request id if present, so logs correlate across services.
            genReqId: (req: IncomingMessage) => {
              const header = req.headers['x-request-id'];
              return (Array.isArray(header) ? header[0] : header) ?? randomUUID();
            },
            customProps: (req: IncomingMessage) => ({ requestId: req.id }),
          },
        }),
        PrismaModule,
        RedisModule,
        AuthModule,
        CatalogModule,
        HealthModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
    };
  }
}
