import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type CheckoutRequest,
  ErrorCode,
  initialOrderStatus,
  ORDER_NUMBER_PREFIX,
  type OrderDetail,
  toShippingAddress,
} from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { variantDemand } from '../cart/cart-lines.js';
import { CartService } from '../cart/cart.service.js';
import { ServiceabilityService } from '../fulfilment/serviceability.service.js';
import { InvoicingService } from '../invoicing/invoicing.service.js';
import { applyStock, OrdersService } from '../orders/orders.service.js';
import { stockEffect } from '../orders/order-stock.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PricingService, type PricingItem, type QuoteResult } from '../pricing/pricing.service.js';

type Tx = Prisma.TransactionClient;

const CHECKOUT_LIMIT = { name: 'checkout:customer', limit: 10, windowSeconds: 10 * 60 };

export interface CheckoutResult {
  order: OrderDetail;
  /** True when this Idempotency-Key already created an order (nothing new happened). */
  replayed: boolean;
}

/**
 * Turns the customer's cart into an order (CLAUDE.md §6 steps 2–3, 8).
 * Payment (Razorpay order creation) is added in the payments slice.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly pricing: PricingService,
    private readonly serviceability: ServiceabilityService,
    private readonly orders: OrdersService,
    private readonly settings: SettingsService,
    private readonly rateLimiter: RateLimiterService,
    private readonly payments: PaymentsService,
    private readonly invoicing: InvoicingService,
  ) {}

  async checkout(
    customerId: string,
    idempotencyKey: string,
    request: CheckoutRequest,
    ip: string,
  ): Promise<CheckoutResult> {
    const existing = await this.findByKey(this.prisma, customerId, idempotencyKey);
    if (existing) {
      // A retry also recovers from a Razorpay outage during the first attempt.
      await this.payments.ensurePayment(existing);
      return { order: await this.orders.detailById(existing), replayed: true };
    }
    await this.rateLimiter.consume(CHECKOUT_LIMIT, customerId);

    // Fast, friendly checks outside the transaction (re-checked inside where it matters).
    const view = await this.cart.get({ customerId, guestCartId: null, ip }, request.paymentMethod);
    if (view.lines.length === 0) throw cartEmpty();
    const problems = view.lines.filter((l) => l.issue !== null);
    if (problems.length > 0) {
      throw new AppException(
        ErrorCode.CART_HAS_ISSUES,
        'Some items in your cart can’t be bought right now.',
        HttpStatus.CONFLICT,
        { lines: problems.map((l) => ({ id: l.id, issue: l.issue })) },
      );
    }

    const address = toShippingAddress(request.address);
    const weightGrams = await this.parcelWeight(customerId);
    const delivery = await this.serviceability.check(address.pincode, weightGrams);
    if (!delivery.serviceable) {
      throw new AppException(
        ErrorCode.NOT_SERVICEABLE,
        'Sorry, we don’t deliver to this PIN code yet.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (request.paymentMethod === 'cod' && !delivery.codAvailable) {
      throw new AppException(
        ErrorCode.COD_UNAVAILABLE,
        'Cash on Delivery isn’t available for this PIN code. Please pay online.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const settings = await this.settings.getAll();
    const orderId = await this.prisma.$transaction(
      (tx) => this.placeOrder(tx, customerId, idempotencyKey, request, address, settings),
      { timeout: 15_000 },
    );
    // Prepaid: create the Razorpay order now that ours is committed. If Razorpay is down this
    // throws 503; the order stays reserved and retrying with the same key completes it.
    await this.payments.ensurePayment(orderId);
    const order = await this.orders.detailById(orderId);
    // COD (and fully wallet-paid) orders start confirmed, so they are invoiced straight away.
    if (order.status === 'confirmed') await this.invoicing.queueInvoice(orderId);
    return { order, replayed: false };
  }

  private async placeOrder(
    tx: Tx,
    customerId: string,
    idempotencyKey: string,
    request: CheckoutRequest,
    address: ReturnType<typeof toShippingAddress>,
    settings: Awaited<ReturnType<SettingsService['getAll']>>,
  ): Promise<string> {
    // One checkout per customer at a time: protects the trial-kit and per-customer limits.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${customerId}::uuid FOR UPDATE`;
    const replay = await this.findByKey(tx, customerId, idempotencyKey);
    if (replay) return replay;

    const cart = await tx.cart.findUnique({
      where: { userId: customerId },
      include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!cart || cart.items.length === 0) throw cartEmpty();

    const items: PricingItem[] = cart.items.map((item) =>
      item.variantId
        ? { key: item.id, variantId: item.variantId, quantity: item.quantity }
        : {
            key: item.id,
            bundleId: item.bundleId!,
            quantity: item.quantity,
            selection: selectionOf(item.bundleSelection),
          },
    );
    const priced: QuoteResult = await this.pricing.quote({
      items,
      paymentMethod: request.paymentMethod,
      discountCode: cart.discountCode,
      customerId,
    });
    const { quote, lines, discount } = priced;

    // Trial kit: one per customer, ever (CLAUDE.md §1, §10 edge case).
    const limited = lines.filter((l) => l.onePerCustomer);
    if (limited.some((l) => l.quantity > 1)) throw purchaseLimit();
    const bought = await this.cart.purchasedProductIds(
      customerId,
      limited.map((l) => l.productId!).filter(Boolean),
    );
    if (bought.size > 0) throw purchaseLimit();

    // Discount usage limits, re-checked under a lock on the discount row.
    if (discount) {
      await tx.$queryRaw`SELECT id FROM discounts WHERE id = ${discount.id}::uuid FOR UPDATE`;
      const row = await tx.discount.findUniqueOrThrow({ where: { id: discount.id } });
      const [used, usedByCustomer] = await Promise.all([
        tx.discountRedemption.count({ where: { discountId: row.id } }),
        tx.discountRedemption.count({ where: { discountId: row.id, customerId } }),
      ]);
      if (
        (row.usageLimit !== null && used >= row.usageLimit) ||
        (row.perCustomerLimit !== null && usedByCustomer >= row.perCustomerLimit)
      ) {
        throw new AppException(
          ErrorCode.DISCOUNT_NOT_APPLICABLE,
          `${row.code} can no longer be used.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    // Stock: lock the variants (fixed order), check availability, then reserve or deduct.
    const demand = variantDemand(
      lines.map((l) => ({
        variantId: l.variantId,
        bundleId: l.bundleId,
        selection: l.selection,
        quantity: l.quantity,
      })),
    );
    const variantIds = [...demand.keys()].sort();
    const stock = await tx.$queryRaw<{ id: string; available: number }[]>`
      SELECT id, stock - reserved_stock AS available FROM variants
      WHERE id = ANY(${variantIds}::uuid[]) ORDER BY id FOR UPDATE`;
    const available = new Map(stock.map((s) => [s.id, Number(s.available)]));
    for (const [variantId, qty] of demand) {
      if ((available.get(variantId) ?? 0) < qty) {
        throw new AppException(
          ErrorCode.OUT_OF_STOCK,
          'Some items just sold out. Please review your cart.',
          HttpStatus.CONFLICT,
        );
      }
    }

    // A ₹0 prepaid order (fully discounted) needs no payment step.
    const status =
      request.paymentMethod === 'prepaid' && quote.totalPaise === 0
        ? 'confirmed'
        : initialOrderStatus(request.paymentMethod);
    await applyStock(tx, stockEffect(null, status), demand);

    const seqRows = await tx.$queryRaw<
      { seq: bigint }[]
    >`SELECT nextval('order_number_seq') AS seq`;
    const seq = seqRows[0]!.seq;
    const pricedByKey = new Map(quote.lines.map((l) => [l.key, l]));
    const order = await tx.order.create({
      data: {
        number: `${ORDER_NUMBER_PREFIX}${seq}`,
        customerId,
        status,
        paymentMethod: request.paymentMethod,
        subtotalPaise: quote.subtotalPaise,
        discountPaise: quote.discountPaise,
        walletPaise: quote.walletPaise,
        shippingPaise: quote.shippingPaise,
        codFeePaise: quote.codFeePaise,
        taxPaise: quote.taxPaise,
        totalPaise: quote.totalPaise,
        shippingAddress: address,
        discountId: discount?.id ?? null,
        idempotencyKey,
        reservationExpiresAt:
          status === 'pending_payment'
            ? new Date(Date.now() + settings['checkout.reservation_minutes'] * 60_000)
            : null,
        items: {
          create: lines.map((line) => {
            const p = pricedByKey.get(line.key)!;
            return {
              variantId: line.variantId,
              bundleId: line.bundleId,
              bundleSelection: line.selection ?? undefined,
              productName: line.productName,
              variantName: line.variantName,
              sku: line.sku,
              hsnCode: line.hsnCode,
              gstRateBps: line.gstRateBps,
              unitPricePaise: p.unitPricePaise,
              quantity: p.quantity,
              lineTotalPaise: p.lineTotalPaise,
              discountPaise: p.discountPaise,
              taxPaise: p.taxPaise,
            };
          }),
        },
        events: {
          create: { fromStatus: null, toStatus: status, actor: 'customer', actorRef: customerId },
        },
      },
    });

    if (discount && quote.discountPaise > 0) {
      await tx.discountRedemption.create({
        data: {
          discountId: discount.id,
          orderId: order.id,
          customerId,
          amountPaise: quote.discountPaise,
        },
      });
    }

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    await tx.cart.update({ where: { id: cart.id }, data: { discountCode: null } });

    if (request.saveAddress) {
      const hasDefault = await tx.address.count({ where: { userId: customerId, isDefault: true } });
      await tx.address.create({
        data: {
          userId: customerId,
          name: address.name,
          phone: address.phone,
          line1: address.line1,
          line2: address.line2,
          landmark: address.landmark,
          city: address.city,
          state: address.state,
          stateCode: address.stateCode,
          pincode: address.pincode,
          isDefault: hasDefault === 0,
        },
      });
    }

    this.logger.log(
      `Order placed (orderId=${order.id}, customerId=${customerId}, status=${status}, totalPaise=${quote.totalPaise})`,
    );
    return order.id;
  }

  private async findByKey(
    db: Pick<Tx, 'order'>,
    customerId: string,
    idempotencyKey: string,
  ): Promise<string | null> {
    const order = await db.order.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      select: { id: true },
    });
    return order?.id ?? null;
  }

  /** Parcel weight for the courier check: variant weights × quantity, bundle picks included. */
  private async parcelWeight(customerId: string): Promise<number> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId: customerId },
      include: { items: true },
    });
    const demand = variantDemand(
      (cart?.items ?? []).map((i) => ({
        variantId: i.variantId,
        bundleId: i.bundleId,
        selection: selectionOf(i.bundleSelection),
        quantity: i.quantity,
      })),
    );
    const variants = await this.prisma.variant.findMany({
      where: { id: { in: [...demand.keys()] } },
      select: { id: true, weightG: true },
    });
    return variants.reduce((sum, v) => sum + v.weightG * (demand.get(v.id) ?? 0), 0);
  }
}

function selectionOf(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function cartEmpty(): AppException {
  return new AppException(
    ErrorCode.CART_EMPTY,
    'Your cart is empty.',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function purchaseLimit(): AppException {
  return new AppException(
    ErrorCode.PURCHASE_LIMIT,
    'The trial kit is limited to one per customer.',
    HttpStatus.CONFLICT,
  );
}
