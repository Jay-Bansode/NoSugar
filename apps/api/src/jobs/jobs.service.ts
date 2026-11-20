import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env.js';

export type JobHandler = (data: Record<string, unknown>) => Promise<void>;

const QUEUE = 'jobs';

/**
 * Background jobs on BullMQ (CLAUDE.md §2): one queue, one worker in the API process, jobs
 * dispatched by name to handlers that feature modules register in onModuleInit.
 * Failed jobs retry with exponential backoff. Scheduled (repeating) jobs don't run in tests,
 * which call the underlying services directly. JOBS_ENABLED=false turns it all off.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<string, number>();
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Registers the function that runs jobs of this name. */
  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  /** Runs `name` every `everyMs` (once across all API instances). */
  schedule(name: string, everyMs: number, handler: JobHandler): void {
    this.register(name, handler);
    this.schedules.set(name, everyMs);
  }

  /**
   * Queues a job. `jobId` makes enqueueing idempotent: a job with the same id that is waiting
   * or running isn't added twice. Ids must not contain ':'.
   */
  async enqueue(name: string, data: Record<string, unknown>, jobId?: string): Promise<void> {
    if (!this.queue) {
      this.logger.warn(`Jobs disabled; not queueing ${name}`);
      return;
    }
    await this.queue.add(name, data, jobId ? { jobId } : {});
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.JOBS_ENABLED) return;
    const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
    // Separate key space per environment, so tests never pick up a dev server's jobs.
    const prefix = `brand:${this.env.NODE_ENV}`;
    this.queue = new Queue(QUEUE, {
      connection,
      prefix,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    this.queue.on('error', (err) => this.logger.warn(`Queue error: ${err.message}`));

    this.worker = new Worker(QUEUE, (job) => this.run(job), { connection, prefix, concurrency: 5 });
    this.worker.on('error', (err) => this.logger.warn(`Worker error: ${err.message}`));
    this.worker.on('failed', (job, err) =>
      this.logger.warn(
        `Job ${job?.name} (${job?.id}) failed, attempt ${job?.attemptsMade}: ${err.message}`,
      ),
    );

    if (this.env.NODE_ENV !== 'test') {
      for (const [name, every] of this.schedules) {
        await this.queue.upsertJobScheduler(name, { every }, { name });
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) throw new Error(`No handler for job "${job.name}"`);
    await handler((job.data ?? {}) as Record<string, unknown>);
  }
}

@Global()
@Module({
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
