import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  assertOrderTransition,
  ErrorCode,
  InvalidOrderTransitionError,
  isCancellable,
  type OrderDetail,
  type OrderStatus,
  type OrderSummary,
  type Paginated,
  shippingAddressSchema,
} from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { ENV, type Env } from '../../config/env.js';
import type { OrderEventActor, Prisma } from '../../generated/prisma/client.js';
import { JobsService } from '../../jobs/jobs.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InvoicingService } from '../invoicing/invoicing.service.js';
import { FAKE_KEY_ID } from '../payments/fake.gateway.js';
import { orderDemand, type StockEffect, stockEffect } from './order-stock.js';

/** Job that issues a refund with Razorpay (handled by the payments module). */
export const ISSUE_REFUND_JOB = 'issue-refund';
const EXPIRE_JOB = 'expire-reservations';

type Tx = Prisma.TransactionClient;

export interface TransitionContext {
  actor: OrderEventActor;
  actorRef?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue;
}

const DETAIL_INCLUDE = {
  items: true,
  events: { orderBy: { id: 'asc' } },
  payments: { orderBy: { createdAt: 'desc' } },
  refunds: { orderBy: { createdAt: 'desc' }, take: 1 },
  invoice: { include: { creditNotes: { orderBy: { issuedAt: 'asc' } } } },
} satisfies Prisma.OrderInclude;

type OrderWithDetail = Prisma.OrderGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const UNPAID: readonly OrderStatus[] = ['pending_payment', 'payment_failed'];
const EXPIRY_BATCH = 100;

/**
 * Orders. Every status change goes through `transition`, the one place that checks the state
 * machine, writes the order_events row and moves stock (CLAUDE.md §5).
 */
@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);
  private readonly paymentKeyId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly invoicing: InvoicingService,
    @Inject(ENV) env: Env,
  ) {
    this.paymentKeyId =
      env.PAYMENT_PROVIDER === 'razorpay' ? (env.RAZORPAY_KEY_ID ?? '') : FAKE_KEY_ID;
  }

  onModuleInit(): void {
    // CLAUDE.md §6 step 9: release stock held by unpaid orders, checked every minute.
    this.jobs.schedule(EXPIRE_JOB, 60_000, async () => {
      const expired = await this.expireReservations();
      if (expired > 0)
        this.logger.log(`Cancelled ${expired} unpaid order(s) past their reservation`);
    });
  }

  /** Changes an order's status inside `tx`. Locks the order row first. */
  async transition(
    tx: Tx,
    orderId: string,
    to: OrderStatus,
    ctx: TransitionContext,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    try {
      assertOrderTransition(order.status, to);
    } catch (err) {
      if (err instanceof InvalidOrderTransitionError) {
        throw new AppException(
          ErrorCode.CONFLICT,
          `Order can't move from ${order.status} to ${to}`,
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }

    await applyStock(tx, stockEffect(order.status, to), orderDemand(order.items));
    if (to === 'cancelled') {
      // A cancelled order no longer uses up a discount code.
      await tx.discountRedemption.deleteMany({ where: { orderId } });
    }
    if (to === 'cancelled' || to === 'returned') {
      // The supply didn't happen (or came back): reverse whatever is left on the invoice.
      // Partial refunds of delivered orders issue their own credit note for the amount.
      await this.invoicing.issueCreditNote(tx, orderId, {
        amountPaise: 'remaining',
        reason:
          to === 'returned'
            ? 'Goods returned'
            : `Order cancelled${ctx.note ? ` (${ctx.note})` : ''}`,
      });
    }
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: to,
        ...(UNPAID.includes(to) ? {} : { reservationExpiresAt: null }),
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: to,
        actor: ctx.actor,
        actorRef: ctx.actorRef ?? null,
        note: ctx.note ?? null,
        metadata: ctx.metadata ?? {},
      },
    });
    this.logger.log(`Order ${order.status} → ${to} (orderId=${orderId}, actor=${ctx.actor})`);
  }

  async list(
    customerId: string,
    query: { cursor?: string | undefined; limit: number },
  ): Promise<Paginated<OrderSummary>> {
    const rows = await this.prisma.order.findMany({
      where: { customerId },
      include: { items: { select: { productName: true, quantity: true }, orderBy: { id: 'asc' } } },
      orderBy: { id: 'desc' }, // UUIDv7: newest first
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((o) => ({
        number: o.number,
        status: o.status,
        paymentMethod: o.paymentMethod,
        createdAt: o.createdAt.toISOString(),
        totalPaise: o.totalPaise,
        itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        firstItemName: o.items[0]?.productName ?? '',
      })),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(customerId: string, number: string): Promise<OrderDetail> {
    return this.toDetail(await this.findOwn(customerId, number));
  }

  /** The id of the customer's order, or 404 (also for other customers' orders). */
  async ownOrderId(customerId: string, number: string): Promise<string> {
    const order = await this.prisma.order.findFirst({
      where: { number, customerId },
      select: { id: true },
    });
    if (!order)
      throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    return order.id;
  }

  async detailById(orderId: string): Promise<OrderDetail> {
    return this.toDetail(
      await this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: DETAIL_INCLUDE,
      }),
    );
  }

  /**
   * Customer cancellation, before dispatch only. A paid prepaid order is refunded in full:
   * the refund row is written with the cancellation and issued by a retried background job.
   */
  async cancelByCustomer(customerId: string, number: string): Promise<OrderDetail> {
    const order = await this.findOwn(customerId, number);
    if (!isCancellable(order.status)) {
      throw new AppException(
        ErrorCode.ORDER_NOT_CANCELLABLE,
        'This order can no longer be cancelled.',
        HttpStatus.CONFLICT,
      );
    }
    const refundId = await this.prisma.$transaction(async (tx) => {
      await this.transition(tx, order.id, 'cancelled', {
        actor: 'customer',
        actorRef: customerId,
        note: 'Cancelled by customer',
      });
      return this.createFullRefund(tx, order.id, 'Cancelled by customer', customerId);
    });
    if (refundId) await this.jobs.enqueue(ISSUE_REFUND_JOB, { refundId }, `refund-${refundId}`);
    return this.detailById(order.id);
  }

  /**
   * Writes a pending full refund for the order's captured payment, if there is one and it
   * isn't refunded yet. Returns the refund id to issue, or null when nothing was paid.
   */
  async createFullRefund(
    tx: Tx,
    orderId: string,
    reason: string,
    createdBy: string,
  ): Promise<string | null> {
    const payment = await tx.payment.findFirst({
      where: { orderId, status: 'captured', razorpayPaymentId: { not: null } },
      include: { refunds: true },
    });
    if (!payment) return null;
    const alreadyRefunded = payment.refunds
      .filter((r) => r.status !== 'failed')
      .reduce((sum, r) => sum + r.amountPaise, 0);
    const amount = payment.amountPaise - alreadyRefunded;
    if (amount <= 0) return null;
    const refund = await tx.refund.create({
      data: { orderId, paymentId: payment.id, amountPaise: amount, reason, createdBy },
    });
    this.logger.log(
      `Refund created (orderId=${orderId}, refundId=${refund.id}, amountPaise=${amount})`,
    );
    return refund.id;
  }

  /**
   * Cancels unpaid prepaid orders whose reservation time has passed and releases their stock
   * (CLAUDE.md §6 step 9). Safe to run concurrently: each order is re-checked under its lock.
   */
  async expireReservations(now = new Date()): Promise<number> {
    const due = await this.prisma.order.findMany({
      where: { status: { in: [...UNPAID] }, reservationExpiresAt: { lte: now } },
      select: { id: true },
      orderBy: { reservationExpiresAt: 'asc' },
      take: EXPIRY_BATCH,
    });
    let expired = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
        const current = await tx.order.findUniqueOrThrow({ where: { id } });
        // Paid (or otherwise moved on) since we looked: leave it alone.
        if (
          !UNPAID.includes(current.status) ||
          !current.reservationExpiresAt ||
          current.reservationExpiresAt > now
        ) {
          return false;
        }
        await this.transition(tx, id, 'cancelled', {
          actor: 'system',
          note: 'Payment not received in time',
        });
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  private async findOwn(customerId: string, number: string): Promise<OrderWithDetail> {
    const order = await this.prisma.order.findFirst({
      where: { number, customerId },
      include: DETAIL_INCLUDE,
    });
    // Same 404 for "not yours" and "doesn't exist".
    if (!order)
      throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    return order;
  }

  private toDetail(order: OrderWithDetail): OrderDetail {
    return {
      number: order.number,
      status: order.status,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt.toISOString(),
      lines: [...order.items]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => ({
          name: item.productName,
          variantName: item.variantName,
          sku: item.sku,
          quantity: item.quantity,
          unitPricePaise: item.unitPricePaise,
          lineTotalPaise: item.lineTotalPaise,
        })),
      totals: {
        subtotalPaise: order.subtotalPaise,
        discountPaise: order.discountPaise,
        walletPaise: order.walletPaise,
        shippingPaise: order.shippingPaise,
        codFeePaise: order.codFeePaise,
        taxPaise: order.taxPaise,
        totalPaise: order.totalPaise,
      },
      shippingAddress: shippingAddressSchema.parse(order.shippingAddress),
      payBy:
        UNPAID.includes(order.status) && order.reservationExpiresAt
          ? order.reservationExpiresAt.toISOString()
          : null,
      canCancel: isCancellable(order.status),
      timeline: order.events.map((e) => ({ status: e.toStatus, at: e.createdAt.toISOString() })),
      payment: this.paymentDetails(order),
      refund: order.refunds[0]
        ? { status: order.refunds[0].status, amountPaise: order.refunds[0].amountPaise }
        : null,
      invoice: order.invoice
        ? {
            number: order.invoice.number,
            issuedAt: order.invoice.issuedAt.toISOString(),
            totalPaise: order.invoice.totalPaise,
          }
        : null,
      creditNotes: (order.invoice?.creditNotes ?? []).map((c) => ({
        id: c.id,
        number: c.number,
        issuedAt: c.issuedAt.toISOString(),
        totalPaise: c.totalPaise,
      })),
    };
  }

  /** Razorpay Checkout details while the order still needs paying (retries reuse the order). */
  private paymentDetails(order: OrderWithDetail): OrderDetail['payment'] {
    if (order.paymentMethod !== 'prepaid' || !UNPAID.includes(order.status)) return null;
    const open = order.payments.find((p) => p.status === 'created' || p.status === 'failed');
    if (!open) return null;
    return {
      provider: 'razorpay',
      keyId: this.paymentKeyId,
      razorpayOrderId: open.razorpayOrderId,
      amountPaise: open.amountPaise,
      currency: 'INR',
    };
  }
}

/** Applies a stock effect to every variant the order uses. DB CHECKs stop negatives. */
export async function applyStock(
  tx: Tx,
  effect: StockEffect,
  demand: Map<string, number>,
): Promise<void> {
  if (!effect) return;
  // Fixed order (by id) so concurrent orders never deadlock on variant rows.
  for (const [variantId, qty] of [...demand].sort(([a], [b]) => a.localeCompare(b))) {
    switch (effect) {
      case 'reserve':
        await tx.$executeRaw`UPDATE variants SET reserved_stock = reserved_stock + ${qty} WHERE id = ${variantId}::uuid`;
        break;
      case 'deduct':
        await tx.$executeRaw`UPDATE variants SET stock = stock - ${qty} WHERE id = ${variantId}::uuid`;
        break;
      case 'confirm':
        await tx.$executeRaw`UPDATE variants SET stock = stock - ${qty}, reserved_stock = reserved_stock - ${qty} WHERE id = ${variantId}::uuid`;
        break;
      case 'release':
        await tx.$executeRaw`UPDATE variants SET reserved_stock = reserved_stock - ${qty} WHERE id = ${variantId}::uuid`;
        break;
      case 'restock':
        await tx.$executeRaw`UPDATE variants SET stock = stock + ${qty} WHERE id = ${variantId}::uuid`;
        break;
    }
  }
}
