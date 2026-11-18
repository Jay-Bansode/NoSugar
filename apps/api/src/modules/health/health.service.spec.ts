import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../../config/env.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [HealthService, { provide: ENV, useValue: { APP_VERSION: '1.2.3' } as Env }],
    }).compile();
    service = moduleRef.get(HealthService);
  });

  it('reports ok with version and ISO time', () => {
    const now = new Date('2026-11-19T10:00:00.000Z');
    expect(service.check(now)).toEqual({
      status: 'ok',
      version: '1.2.3',
      time: '2026-11-19T10:00:00.000Z',
    });
  });
});
