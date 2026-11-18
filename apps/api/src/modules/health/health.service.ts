import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface HealthStatus {
  status: 'ok';
  version: string;
  time: string;
}

export interface ReadinessStatus {
  status: 'ok';
  checks: { database: 'up' };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  /** Liveness: the process is up. Never touches dependencies. */
  check(now: Date = new Date()): HealthStatus {
    return { status: 'ok', version: this.env.APP_VERSION, time: now.toISOString() };
  }

  /** Readiness: dependencies are reachable. Redis is added with the auth/queue slice. */
  async ready(): Promise<ReadinessStatus> {
    if (!(await this.prisma.isHealthy())) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Not ready',
        HttpStatus.SERVICE_UNAVAILABLE,
        { checks: { database: 'down' } },
      );
    }
    return { status: 'ok', checks: { database: 'up' } };
  }
}
