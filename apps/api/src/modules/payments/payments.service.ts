import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ErrorCode, type OrderDetail, type VerifyPayment } from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import type { OrderEventActor } from '../../generated/prisma/client.js';
import { JobsService } from '../../jobs/jobs.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InvoicingService } from '../invoicing/invoicing.service.js';
import { ISSUE_REFUND_JOB, OrdersService } from '../orders/orders.service.js';
import { PAYMENT_GATEWAY, type PaymentGateway, PaymentGatewayError } from './gateway.js';

export interface CapturedPayment {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  method: string | null;
  actor: OrderEventActor;
  actorRef?: string | null;
}

export type CaptureOutcome =
  'confirmed' | 'already_confirmed' | 'refunded_late' | 'amount_mismatch';

const UNPAID = ['pending_payment', 'payment_failed'] as const;

/**
 * Razorpay payments (CLAUDE.md §6 steps 3–7). The client's verify call and the webhook both
 * end in `confirmCaptured`, which is idempotent: whichever arrives first confirms the order.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly jobs: JobsService,
    private readonly invoicing: InvoicingService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  onModuleInit(): void {
    this.jobs.register(ISSUE_REFUND_JOB, async (data) => this.issueRefund(String(data.refundId)));
  }

  /**
   * Makes sure an unpaid prepaid order has a Razorpay order to pay against. Reuses an open
   * one (Razorpay allows several attempts per order). The order row lock stops two callers
   * creating two Razorpay orders.
   */
  async ensurePayment(orderId: string): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
          const order = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            include: { payments: true },
          });
          if (
            order.paymentMethod !== 'prepaid' ||
            !(UNPAID as readonly string[]).includes(order.status) ||
            order.totalPaise <= 0 ||
            order.payments.some((p) => p.status === 'created' || p.status === 'failed')
          ) {
            return;
          }
          const rzp = await this.gateway.createOrder({
            amountPaise: order.totalPaise,
            receipt: order.number,
            notes: { order_id: order.id, order_number: order.number },
          });
          await tx.payment.create({
            data: { orderId: order.id, razorpayOrderId: rzp.id, amountPaise: rzp.amountPaise },
          });
        },
        { timeout: 20_000 },
      );
    } catch (err) {
      if (!(err instanceof PaymentGatewayError)) throw err;
      this.logger.warn(`Creating Razorpay order failed (orderId=${orderId}): ${err.message}`);
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        "We couldn't start the payment. Please try again.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Client fast path (§6 step 5): check the Checkout signature, then confirm with Razorpay's
   * own record that this payment belongs to this order, for this amount, and is captured.
   */
  async verify(customerId: string, input: VerifyPayment): Promise<OrderDetail> {
    const payment = await this.prisma.payment.findUnique({
      where: { razorpayOrderId: input.razorpayOrderId },
      include: { order: { select: { id: true, customerId: true } } },
    });
    if (!payment || payment.order.customerId !== customerId) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Payment not found', HttpStatus.NOT_FOUND);
    }
    if (
      !this.gateway.verifyPaymentSignature(
        input.razorpayOrderId,
        input.razorpayPaymentId,
        input.razorpaySignature,
      )
    ) {
      this.logger.warn(`Invalid payment signature (orderId=${payment.order.id})`);
      throw verificationFailed('Payment could not be verified.');
    }

    let remote;
    try {
      remote = await this.gateway.fetchPayment(input.razorpayPaymentId);
      if (remote.status === 'authorized') {
        remote = await this.gateway.capturePayment(remote.id, payment.amountPaise);
      }
    } catch (err) {
      if (!(err instanceof PaymentGatewayError)) throw err;
      this.logger.warn(`Fetching payment failed (orderId=${payment.order.id}): ${err.message}`);
      // The webhook will still confirm the order; tell the client to check back.
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        "We're confirming your payment. Please check your order in a moment.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (remote.orderId !== input.razorpayOrderId || remote.amountPaise !== payment.amountPaise) {
      this.logger.error(`Payment does not match its order (orderId=${payment.order.id})`);
      throw verificationFailed('Payment could not be verified.');
    }
    if (remote.status !== 'captured') {
      throw verificationFailed('Payment was not completed.');
    }

    await this.confirmCaptured({
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: remote.id,
      amountPaise: remote.amountPaise,
      method: remote.method,
      actor: 'customer',
      actorRef: customerId,
    });
    return this.orders.detailById(payment.order.id);
  }

  /**
   * Records a captured payment and confirms its order: stock taken, hold released, status
   * `confirmed`, all in one transaction (§6 step 7). Safe to call repeatedly. A payment for an
   * order that has meanwhile expired is refunded automatically.
   */
  async confirmCaptured(captured: CapturedPayment): Promise<CaptureOutcome> {
    const { outcome, refundId, confirmedOrderId } = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { razorpayOrderId: captured.razorpayOrderId },
      });
      if (!payment) throw new Error(`No payment for Razorpay order ${captured.razorpayOrderId}`);
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${payment.orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });

      if (
        captured.amountPaise !== payment.amountPaise ||
        payment.amountPaise !== order.totalPaise
      ) {
        this.logger.error(
          `Captured amount does not match order (orderId=${order.id}, paymentId=${captured.razorpayPaymentId})`,
        );
        return { outcome: 'amount_mismatch' as const, refundId: null, confirmedOrderId: null };
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          razorpayPaymentId: captured.razorpayPaymentId,
          status: 'captured',
          method: captured.method,
          capturedAt: payment.capturedAt ?? new Date(),
          errorCode: null,
          errorDescription: null,
        },
      });

      if ((UNPAID as readonly string[]).includes(order.status)) {
        await this.orders.transition(tx, order.id, 'confirmed', {
          actor: captured.actor,
          actorRef: captured.actorRef ?? captured.razorpayPaymentId,
          metadata: { razorpayPaymentId: captured.razorpayPaymentId },
        });
        return { outcome: 'confirmed' as const, refundId: null, confirmedOrderId: order.id };
      }
      if (order.status === 'cancelled') {
        // Paid after the order expired: stock was released, so give the money back.
        const refundId = await this.orders.createFullRefund(
          tx,
          order.id,
          'Payment received after the order was cancelled',
          'system',
        );
        this.logger.warn(`Late payment on cancelled order; refunding (orderId=${order.id})`);
        return { outcome: 'refunded_late' as const, refundId, confirmedOrderId: null };
      }
      return { outcome: 'already_confirmed' as const, refundId: null, confirmedOrderId: null };
    });
    if (refundId) await this.jobs.enqueue(ISSUE_REFUND_JOB, { refundId }, `refund-${refundId}`);
    if (confirmedOrderId) await this.invoicing.queueInvoice(confirmedOrderId);
    return outcome;
  }

  /** A payment attempt failed (webhook). The customer may retry on the same Razorpay order. */
  async markFailed(input: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    errorCode: string | null;
    errorDescription: string | null;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { razorpayOrderId: input.razorpayOrderId },
      });
      if (!payment || payment.status === 'captured') return;
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${payment.orderId}::uuid FOR UPDATE`;
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          errorCode: input.errorCode?.slice(0, 100) ?? null,
          errorDescription: input.errorDescription?.slice(0, 500) ?? null,
        },
      });
      const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
      if (order.status === 'pending_payment') {
        await this.orders.transition(tx, order.id, 'payment_failed', {
          actor: 'webhook',
          actorRef: input.razorpayPaymentId,
          metadata: { errorCode: input.errorCode ?? null },
        });
      }
    });
  }

  /** Background job: send a pending refund to Razorpay. Retried on failure, never doubled. */
  async issueRefund(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!refund || refund.razorpayRefundId || refund.status !== 'pending') return;
    if (!refund.payment?.razorpayPaymentId) {
      throw new Error(`Refund ${refundId} has no captured Razorpay payment`);
    }
    const remote = await this.gateway.refund(
      refund.payment.razorpayPaymentId,
      refund.amountPaise,
      refund.id,
    );
    await this.prisma.refund.update({
      where: { id: refund.id },
      data: {
        razorpayRefundId: remote.id,
        status: remote.status,
        processedAt: remote.status === 'processed' ? new Date() : null,
      },
    });
    this.logger.log(`Refund issued (refundId=${refund.id}, razorpayRefundId=${remote.id})`);
  }

  /** refund.processed / refund.failed webhooks. */
  async refundUpdated(input: {
    razorpayRefundId: string;
    refundRef: string | null;
    status: 'processed' | 'failed';
  }): Promise<void> {
    const refund =
      (await this.prisma.refund.findUnique({
        where: { razorpayRefundId: input.razorpayRefundId },
      })) ??
      (input.refundRef
        ? await this.prisma.refund.findUnique({ where: { id: input.refundRef } })
        : null);
    if (!refund) {
      this.logger.warn(`Webhook for unknown refund ${input.razorpayRefundId}`);
      return;
    }
    await this.prisma.refund.update({
      where: { id: refund.id },
      data: {
        razorpayRefundId: input.razorpayRefundId,
        status: input.status,
        processedAt: input.status === 'processed' ? (refund.processedAt ?? new Date()) : null,
      },
    });
  }
}

function verificationFailed(message: string): AppException {
  return new AppException(ErrorCode.PAYMENT_VERIFICATION_FAILED, message, HttpStatus.BAD_REQUEST);
}
