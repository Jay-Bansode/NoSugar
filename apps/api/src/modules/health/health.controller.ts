import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard.js';
import { type HealthStatus, HealthService, type ReadinessStatus } from './health.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness probe. */
  @Get()
  get(): HealthStatus {
    return this.health.check();
  }

  /** Readiness probe: 503 SERVICE_UNAVAILABLE if a dependency is down. */
  @Get('ready')
  ready(): Promise<ReadinessStatus> {
    return this.health.ready();
  }
}
