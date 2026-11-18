import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../config/env.js';

export interface HealthStatus {
  status: 'ok';
  version: string;
  time: string;
}

@Injectable()
export class HealthService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Liveness only. Dependency checks (Postgres, Redis) arrive with those modules in Phase 1. */
  check(now: Date = new Date()): HealthStatus {
    return { status: 'ok', version: this.env.APP_VERSION, time: now.toISOString() };
  }
}
