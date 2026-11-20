import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RedisHealth } from '../../redis/redis.module.js';

export interface HealthStatus {
  status: 'ok';
  version: string;
  time: string;
}

type CheckState = 'up' | 'down';

export interface ReadinessStatus {
  status: 'ok';
  checks: { database: CheckState; redis: CheckState };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisHealth,
  ) {}

  /** Liveness: the process is up. Never touches dependencies. */
  check(now: Date = new Date()): HealthStatus {
    return { status: 'ok', version: this.env.APP_VERSION, time: now.toISOString() };
  }

  /** Readiness: every dependency is reachable. */
  async ready(): Promise<ReadinessStatus> {
    const [database, redis] = await Promise.all([this.prisma.isHealthy(), this.redis.isHealthy()]);
    const checks = { database: state(database), redis: state(redis) };
    if (!database || !redis) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'Not ready',
        HttpStatus.SERVICE_UNAVAILABLE,
        { checks },
      );
    }
    return { status: 'ok', checks };
  }
}

function state(healthy: boolean): CheckState {
  return healthy ? 'up' : 'down';
}
