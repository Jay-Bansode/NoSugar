import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
import type { OrderEventActor, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { orderDemand, type StockEffect, stockEffect } from './order-stock.js';

type Tx = Prisma.TransactionClient;

export interface TransitionContext {
  actor: OrderEventActor;
  actorRef?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue;
}

type OrderWithDetail = Prisma.OrderGetPayload<{
  include: { items: true; events: { orderBy: { id: 'asc' } } };
}>;

const UNPAID: readonly OrderStatus[] = ['pending_payment', 'payment_failed'];
const EXPIRY_BATCH = 100;

/**
 * Orders. Every status change goes through `transition`, the one place that checks the state
 * machine, writes the order_events row and moves stock (CLAUDE.md §5).
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  async detailById(orderId: string): Promise<OrderDetail> {
    return this.toDetail(
      await this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true, events: { orderBy: { id: 'asc' } } },
      }),
    );
  }

  /** Customer cancellation: only before dispatch, and not yet for paid prepaid orders. */
  async cancelByCustomer(customerId: string, number: string): Promise<OrderDetail> {
    const order = await this.findOwn(customerId, number);
    if (!canCustomerCancel(order)) {
      const paid = isCancellable(order.status) && order.paymentMethod === 'prepaid';
      throw new AppException(
        ErrorCode.ORDER_NOT_CANCELLABLE,
        paid
          ? 'This order is paid. Please contact support to cancel and get a refund.'
          : 'This order can no longer be cancelled.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction((tx) =>
      this.transition(tx, order.id, 'cancelled', {
        actor: 'customer',
        actorRef: customerId,
        note: 'Cancelled by customer',
      }),
    );
    return this.detailById(order.id);
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
      include: { items: true, events: { orderBy: { id: 'asc' } } },
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
      canCancel: canCustomerCancel(order),
      timeline: order.events.map((e) => ({ status: e.toStatus, at: e.createdAt.toISOString() })),
      payment: null,
    };
  }
}

function canCustomerCancel(order: {
  status: OrderStatus;
  paymentMethod: string;
  totalPaise: number;
}): boolean {
  if (!isCancellable(order.status)) return false;
  // Paid prepaid orders need a refund; that arrives with Razorpay refunds.
  return order.paymentMethod === 'cod' || UNPAID.includes(order.status) || order.totalPaise === 0;
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
