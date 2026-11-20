import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ErrorCode } from '@brand/shared';
import { createHash } from 'node:crypto';
import { AppException } from '../../common/app.exception.js';
import { JobsService } from '../../jobs/jobs.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payments/gateway.js';
import { PaymentsService } from '../payments/payments.service.js';
import { razorpayWebhookSchema } from './razorpay-webhook.js';

export const PROCESS_WEBHOOK_JOB = 'process-webhook';

/**
 * Inbound webhooks (CLAUDE.md §7): verify the signature, store the event once (unique per
 * source + external id), answer 200 straight away, and process it in a background job.
 * Processing is idempotent, so retries and duplicate deliveries are harmless.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly jobs: JobsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  onModuleInit(): void {
    this.jobs.register(PROCESS_WEBHOOK_JOB, async (data) =>
      this.process(String(data.webhookEventId)),
    );
  }

  /** Returns true when the event was new (false for a duplicate delivery). */
  async receiveRazorpay(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventId: string | undefined,
  ): Promise<boolean> {
    if (!rawBody || !signature || !this.gateway.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Rejected Razorpay webhook with a bad signature');
      throw new AppException(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        'Invalid signature',
        HttpStatus.BAD_REQUEST,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppException(ErrorCode.BAD_REQUEST, 'Invalid JSON', HttpStatus.BAD_REQUEST);
    }
    const eventType =
      typeof payload === 'object' && payload && 'event' in payload
        ? String((payload as { event: unknown }).event).slice(0, 100)
        : 'unknown';
    // Razorpay sends a unique id per event (and the same id on redelivery).
    const externalEventId =
      eventId?.slice(0, 200) || `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;

    const { count } = await this.prisma.webhookEvent.createMany({
      data: [{ source: 'razorpay', externalEventId, eventType, payload: payload as never }],
      skipDuplicates: true,
    });
    const row = await this.prisma.webhookEvent.findUniqueOrThrow({
      where: { source_externalEventId: { source: 'razorpay', externalEventId } },
      select: { id: true, processedAt: true },
    });
    // Queue unless already done; the job id stops a redelivery queueing it twice.
    if (!row.processedAt) {
      await this.jobs.enqueue(PROCESS_WEBHOOK_JOB, { webhookEventId: row.id }, `webhook-${row.id}`);
    }
    return count === 1;
  }

  /** Background job. Throws to let the queue retry; records the error on the event. */
  async process(webhookEventId: string): Promise<void> {
    const event = await this.prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { attempts: { increment: 1 } },
    });
    if (event.processedAt) return;
    try {
      if (event.source === 'razorpay') await this.handleRazorpay(event.payload);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), error: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { error: message.slice(0, 1000) },
      });
      throw err;
    }
  }

  private async handleRazorpay(raw: unknown): Promise<void> {
    const parsed = razorpayWebhookSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Unreadable Razorpay webhook payload');
    const { event, payload } = parsed.data;
    const payment = payload.payment?.entity;
    const refund = payload.refund?.entity;

    switch (event) {
      case 'payment.captured':
        if (!payment?.order_id) throw new Error('payment.captured without an order id');
        await this.payments.confirmCaptured({
          razorpayOrderId: payment.order_id,
          razorpayPaymentId: payment.id,
          amountPaise: payment.amount,
          method: payment.method ?? null,
          actor: 'webhook',
        });
        return;
      case 'payment.failed':
        if (!payment?.order_id) return;
        await this.payments.markFailed({
          razorpayOrderId: payment.order_id,
          razorpayPaymentId: payment.id,
          errorCode: payment.error_code ?? null,
          errorDescription: payment.error_description ?? null,
        });
        return;
      case 'refund.processed':
      case 'refund.failed': {
        if (!refund) return;
        const notes = refund.notes && !Array.isArray(refund.notes) ? refund.notes : {};
        await this.payments.refundUpdated({
          razorpayRefundId: refund.id,
          refundRef: typeof notes.refund_ref === 'string' ? notes.refund_ref : null,
          status: event === 'refund.processed' ? 'processed' : 'failed',
        });
        return;
      }
      default:
        // Stored for audit; nothing to do.
        return;
    }
  }
}
