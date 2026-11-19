import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ENV, type Env } from '../../config/env.js';
import { REDIS } from '../../redis/redis.module.js';
import { OrdersService } from './orders.service.js';

const INTERVAL_MS = 60_000;
const LOCK_KEY = 'lock:reservation-sweep';
const LOCK_SECONDS = 55;

/**
 * Cancels unpaid orders past their reservation time, once a minute. A Redis lock makes sure
 * only one API instance sweeps at a time. Moves to a BullMQ repeatable job when the queue
 * lands with webhooks. Off in tests, which call OrdersService.expireReservations directly.
 */
@Injectable()
export class ReservationSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReservationSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly orders: OrdersService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.sweep(), INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    try {
      const locked = await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_SECONDS, 'NX');
      if (locked !== 'OK') return;
      const expired = await this.orders.expireReservations();
      if (expired > 0)
        this.logger.log(`Cancelled ${expired} unpaid order(s) past their reservation`);
    } catch (err) {
      this.logger.warn(
        `Reservation sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
