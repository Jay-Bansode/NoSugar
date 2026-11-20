import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type AdminOrderDetail,
  type AdminOrderListQuery,
  type AdminOrderSummary,
  type AdminRefund,
  canTransitionOrder,
  ErrorCode,
  isCancellable,
  normalizeIndianMobile,
  type Paginated,
  REFUNDABLE_STATUSES,
  type RefundBasis,
  refundablePaise,
  RefundRuleError,
  shippingAddressSchema,
  statusAfterRefund,
} from '@brand/shared';
import { AuditService } from '../../audit/audit.service.js';
import { AppException } from '../../common/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import { JobsService } from '../../jobs/jobs.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AdminContext } from '../admin/admin.guard.js';
import { InvoicingService, type PdfFile } from '../invoicing/invoicing.service.js';
import { ISSUE_REFUND_JOB, OrdersService } from './orders.service.js';

const DETAIL_INCLUDE = {
  customer: { select: { id: true, phone: true, name: true, email: true } },
  discount: { select: { code: true } },
  items: { orderBy: { id: 'asc' } },
  events: { orderBy: { id: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
  invoice: { include: { creditNotes: { orderBy: { issuedAt: 'asc' } } } },
} satisfies Prisma.OrderInclude;

type OrderWithDetail = Prisma.OrderGetPayload<{ include: typeof DETAIL_INCLUDE }>;

function basisOf(
  order: Pick<
    OrderWithDetail,
    'status' | 'paymentMethod' | 'totalPaise' | 'codFeePaise' | 'payments' | 'refunds'
  >,
): RefundBasis {
  return {
    status: order.status,
    paymentMethod: order.paymentMethod,
    totalPaise: order.totalPaise,
    codFeePaise: order.codFeePaise,
    capturedPaise: order.payments
      .filter((p) => p.status === 'captured')
      .reduce((sum, p) => sum + p.amountPaise, 0),
    refunds: order.refunds,
  };
}

/**
 * Orders in the admin panel. Status changes go through OrdersService.transition (state machine,
 * stock, order_events, credit notes); this service adds the admin rules and the audit record,
 * written in the same transaction as the change.
 */
@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly invoicing: InvoicingService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  async list(query: AdminOrderListQuery): Promise<Paginated<AdminOrderSummary>> {
    const q = query.q?.trim();
    const phone = q ? normalizeIndianMobile(q) : null;
    const rows = await this.prisma.order.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
        ...(q
          ? {
              OR: [
                { number: { contains: q.toUpperCase() } },
                ...(phone ? [{ customer: { phone } }] : []),
              ],
            }
          : {}),
      },
      include: {
        customer: { select: { phone: true } },
        items: { select: { quantity: true } },
      },
      orderBy: { id: 'desc' }, // UUIDv7: newest first
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((o) => {
        const address = shippingAddressSchema.safeParse(o.shippingAddress);
        return {
          number: o.number,
          status: o.status,
          paymentMethod: o.paymentMethod,
          createdAt: o.createdAt.toISOString(),
          totalPaise: o.totalPaise,
          itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
          customerName: address.success ? address.data.name : '',
          customerPhone: o.customer.phone,
          city: address.success ? address.data.city : '',
        };
      }),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(number: string): Promise<AdminOrderDetail> {
    return this.toDetail(await this.find(number));
  }

  /** Marks a confirmed order as packed (ready for the courier). */
  async pack(admin: AdminContext, number: string): Promise<AdminOrderDetail> {
    const order = await this.find(number);
    await this.prisma.$transaction(async (tx) => {
      await this.orders.transition(tx, order.id, 'packed', {
        actor: 'admin',
        actorRef: admin.adminId,
      });
      await this.audit.record(
        admin,
        { action: 'order.pack', entityType: 'order', entityId: order.number },
        tx,
      );
    });
    return this.detail(number);
  }

  /**
   * Cancels an order before dispatch. Stock goes back, any invoice is credited in full, and a
   * paid prepaid order is refunded in full by the refund job.
   */
  async cancel(admin: AdminContext, number: string, reason: string): Promise<AdminOrderDetail> {
    const order = await this.find(number);
    if (!isCancellable(order.status)) {
      throw new AppException(
        ErrorCode.ORDER_NOT_CANCELLABLE,
        'This order has been dispatched and can no longer be cancelled.',
        HttpStatus.CONFLICT,
      );
    }
    const refundId = await this.prisma.$transaction(async (tx) => {
      await this.orders.transition(tx, order.id, 'cancelled', {
        actor: 'admin',
        actorRef: admin.adminId,
        note: `Cancelled by staff: ${reason}`,
      });
      const refundId = await this.orders.createFullRefund(
        tx,
        order.id,
        `Cancelled by staff: ${reason}`,
        `admin:${admin.adminId}`,
      );
      await this.audit.record(
        admin,
        {
          action: 'order.cancel',
          entityType: 'order',
          entityId: order.number,
          changes: { from: order.status, reason, refundId },
        },
        tx,
      );
      return refundId;
    });
    if (refundId) await this.jobs.enqueue(ISSUE_REFUND_JOB, { refundId }, `refund-${refundId}`);
    return this.detail(number);
  }

  /**
   * Refunds part or all of a delivered (or returned) order. Online payments go back through
   * Razorpay (background job); COD cash is paid back outside the system and recorded here with
   * its bank/UPI reference. Each refund gets a credit note. A repeated request with the same
   * Idempotency-Key returns the first result instead of refunding twice.
   */
  async refund(
    admin: AdminContext,
    number: string,
    input: AdminRefund,
    idempotencyKey: string,
  ): Promise<AdminOrderDetail> {
    const order = await this.find(number);
    const replay = await this.prisma.refund.findUnique({
      where: { orderId_idempotencyKey: { orderId: order.id, idempotencyKey } },
    });
    if (replay) {
      this.audit.noChange(admin);
      return this.toDetail(order);
    }

    let refund;
    try {
      refund = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
        const current = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { payments: true, refunds: true },
        });
        const basis = basisOf(current);
        let nextStatus;
        try {
          nextStatus = statusAfterRefund(basis, input.amountPaise);
        } catch (err) {
          if (err instanceof RefundRuleError) throw refundNotAllowed(err.message);
          throw err;
        }

        const payment =
          input.method === 'razorpay'
            ? current.payments.find((p) => p.status === 'captured' && p.razorpayPaymentId)
            : undefined;
        if (input.method === 'razorpay' && !payment) {
          throw refundNotAllowed(
            'This order wasn’t paid online. Pay the customer back by bank or UPI and record it as a manual refund.',
          );
        }

        const now = new Date();
        const created = await tx.refund.create({
          data: {
            orderId: current.id,
            paymentId: payment?.id ?? null,
            amountPaise: input.amountPaise,
            method: input.method,
            reference: input.method === 'manual' ? (input.reference ?? null) : null,
            idempotencyKey,
            reason: input.reason,
            createdBy: `admin:${admin.adminId}`,
            status: input.method === 'manual' ? 'processed' : 'pending',
            processedAt: input.method === 'manual' ? now : null,
          },
        });

        // Credit note for the refund (a returned order is already credited in full).
        const uncredited = await this.invoicing.uncreditedPaise(tx, current.id);
        if (uncredited && uncredited > 0) {
          await this.invoicing.issueCreditNote(tx, current.id, {
            amountPaise: Math.min(input.amountPaise, uncredited),
            reason: `Refund: ${input.reason}`,
            refundId: created.id,
            now,
          });
        }
        if (nextStatus) {
          await this.orders.transition(tx, current.id, nextStatus, {
            actor: 'admin',
            actorRef: admin.adminId,
            note: `Refund: ${input.reason}`,
            metadata: { refundId: created.id, amountPaise: input.amountPaise },
          });
        }
        await this.audit.record(
          admin,
          {
            action: 'order.refund',
            entityType: 'order',
            entityId: current.number,
            changes: {
              refundId: created.id,
              amountPaise: input.amountPaise,
              method: input.method,
              reference: created.reference,
              reason: input.reason,
              status: { from: current.status, to: nextStatus ?? current.status },
            },
          },
          tx,
        );
        return created;
      });
    } catch (err) {
      // The same request sent twice at once: the second insert hits the unique key.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.audit.noChange(admin);
        return this.detail(number);
      }
      throw err;
    }

    this.logger.log(
      `Admin refund created (orderId=${order.id}, refundId=${refund.id}, method=${refund.method})`,
    );
    if (refund.method === 'razorpay') {
      await this.jobs.enqueue(ISSUE_REFUND_JOB, { refundId: refund.id }, `refund-${refund.id}`);
    }
    return this.detail(number);
  }

  async invoicePdf(number: string): Promise<PdfFile | null> {
    return this.invoicing.invoicePdf((await this.find(number)).id);
  }

  async creditNotePdf(number: string, creditNoteId: string): Promise<PdfFile | null> {
    return this.invoicing.creditNotePdf((await this.find(number)).id, creditNoteId);
  }

  private async find(number: string): Promise<OrderWithDetail> {
    const order = await this.prisma.order.findUnique({
      where: { number },
      include: DETAIL_INCLUDE,
    });
    if (!order)
      throw new AppException(ErrorCode.NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    return order;
  }

  private toDetail(order: OrderWithDetail): AdminOrderDetail {
    const refundable = refundablePaise(basisOf(order));
    return {
      number: order.number,
      status: order.status,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt.toISOString(),
      customer: order.customer,
      shippingAddress: shippingAddressSchema.parse(order.shippingAddress),
      discountCode: order.discount?.code ?? null,
      lines: order.items.map((i) => ({
        name: i.productName,
        variantName: i.variantName,
        sku: i.sku,
        hsnCode: i.hsnCode,
        gstRateBps: i.gstRateBps,
        quantity: i.quantity,
        unitPricePaise: i.unitPricePaise,
        lineTotalPaise: i.lineTotalPaise,
        discountPaise: i.discountPaise,
        taxPaise: i.taxPaise,
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
      timeline: order.events.map((e) => ({
        from: e.fromStatus,
        to: e.toStatus,
        at: e.createdAt.toISOString(),
        actor: e.actor,
        note: e.note,
      })),
      payments: order.payments.map((p) => ({
        id: p.id,
        status: p.status,
        method: p.method,
        amountPaise: p.amountPaise,
        razorpayOrderId: p.razorpayOrderId,
        razorpayPaymentId: p.razorpayPaymentId,
        capturedAt: p.capturedAt?.toISOString() ?? null,
        error: p.errorDescription,
      })),
      refunds: order.refunds.map((r) => ({
        id: r.id,
        amountPaise: r.amountPaise,
        status: r.status,
        method: r.method,
        reason: r.reason,
        reference: r.reference,
        razorpayRefundId: r.razorpayRefundId,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
      })),
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
      refundablePaise: refundable,
      can: {
        pack: canTransitionOrder(order.status, 'packed'),
        cancel: isCancellable(order.status),
        refund: REFUNDABLE_STATUSES.includes(order.status) && refundable > 0,
      },
    };
  }
}

function refundNotAllowed(message: string): AppException {
  return new AppException(ErrorCode.REFUND_NOT_ALLOWED, message, HttpStatus.CONFLICT);
}
