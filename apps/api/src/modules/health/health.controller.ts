import { Controller, Get } from '@nestjs/common';
import { type HealthStatus, HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  get(): HealthStatus {
    return this.health.check();
  }
}
