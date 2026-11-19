import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type PaymentMethod,
  type PriceQuote,
  type PricingDiscount,
  PricingError,
  type PricingLine,
  priceOrder,
} from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';

export const MAX_LINE_QUANTITY = 99;
/** Packs of this size are the only lines trial-kit wallet credit can pay for (CLAUDE.md §1). */
export const WALLET_ELIGIBLE_PACK_SIZE = 15;

export type PricingItem =
  | { key: string; variantId: string; quantity: number }
  | { key: string; bundleId: string; quantity: number; selection: string[] };

/** A priced line plus everything an order needs to snapshot it (CLAUDE.md §8). */
export interface ResolvedLine extends PricingLine {
  /** Product of a variant line; null for bundles. */
  productId: string | null;
  variantId: string | null;
  bundleId: string | null;
  /** Chosen variant ids for a bundle, in the customer's order. */
  selection: string[] | null;
  productName: string;
  variantName: string;
  sku: string;
  hsnCode: string;
  /** Trial kit: one per customer, enforced at checkout. */
  onePerCustomer: boolean;
}

export interface AppliedDiscount {
  id: string;
  code: string;
}

export interface QuoteRequest {
  items: PricingItem[];
  paymentMethod: PaymentMethod;
  discountCode?: string | null | undefined;
  /** Needed to enforce per-customer discount limits; guests are checked again at checkout. */
  customerId?: string | null | undefined;
  /** Wallet balance (Phase 3); 0 until the wallet exists. */
  walletAvailablePaise?: number;
  now?: Date;
}

export interface QuoteResult {
  quote: PriceQuote;
  lines: ResolvedLine[];
  discount: AppliedDiscount | null;
}

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Strict: every item must be sellable. Used by checkout. */
  async quote(request: QuoteRequest): Promise<QuoteResult> {
    const now = request.now ?? new Date();
    const lines = await this.resolveItems(request.items);
    const discount = request.discountCode
      ? await this.resolveDiscount(request.discountCode, request.customerId ?? null, now)
      : null;
    return this.price(lines, {
      paymentMethod: request.paymentMethod,
      discount,
      walletAvailablePaise: request.walletAvailablePaise ?? 0,
    });
  }

  /** Prices already-resolved lines with current fee settings. */
  async price(
    lines: ResolvedLine[],
    options: {
      paymentMethod: PaymentMethod;
      discount: { pricing: PricingDiscount; applied: AppliedDiscount } | null;
      walletAvailablePaise: number;
    },
  ): Promise<QuoteResult> {
    const fees = await this.settings.pricingFees();
    let quote: PriceQuote;
    try {
      quote = priceOrder({
        lines,
        fees,
        paymentMethod: options.paymentMethod,
        discount: options.discount?.pricing ?? null,
        walletAvailablePaise: options.walletAvailablePaise,
      });
    } catch (err) {
      throw toAppException(err);
    }
    return {
      quote,
      lines,
      discount: options.discount && quote.discountPaise > 0 ? options.discount.applied : null,
    };
  }

  /** Loads current prices for the items. Inactive or malformed items → ITEM_UNAVAILABLE. */
  async resolveItems(items: PricingItem[]): Promise<ResolvedLine[]> {
    const results = await this.resolveEach(items);
    const failure = results.find((r) => r instanceof AppException);
    if (failure) throw failure;
    return results as ResolvedLine[];
  }

  /**
   * Lenient: resolves each item independently, returning an AppException in place of any
   * item that can't be sold. Used by the cart, which shows such lines with an issue.
   */
  async resolveEach(items: PricingItem[]): Promise<(ResolvedLine | AppException)[]> {
    const variantIds = new Set<string>();
    const bundleIds = new Set<string>();
    for (const item of items) {
      if ('variantId' in item) variantIds.add(item.variantId);
      else {
        bundleIds.add(item.bundleId);
        item.selection.forEach((id) => variantIds.add(id));
      }
    }

    const [variants, bundles] = await Promise.all([
      this.prisma.variant.findMany({
        where: { id: { in: [...variantIds] }, isActive: true, product: { isActive: true } },
        include: { product: true },
      }),
      this.prisma.bundle.findMany({
        where: { id: { in: [...bundleIds] }, isActive: true },
        include: { items: { select: { variantId: true } } },
      }),
    ]);
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const bundleById = new Map(bundles.map((b) => [b.id, b]));

    return items.map((item): ResolvedLine | AppException => {
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > MAX_LINE_QUANTITY
      ) {
        return unavailable(item.key, `Quantity must be between 1 and ${MAX_LINE_QUANTITY}`);
      }
      if ('variantId' in item) {
        const variant = variantById.get(item.variantId);
        if (!variant) return unavailable(item.key, 'This item is no longer available');
        return {
          key: item.key,
          unitPricePaise: variant.pricePaise,
          quantity: item.quantity,
          gstRateBps: variant.gstRateBps,
          discountable: variant.product.type !== 'trial_kit',
          walletEligible:
            variant.product.type === 'coffee' && variant.packSize === WALLET_ELIGIBLE_PACK_SIZE,
          productId: variant.productId,
          variantId: variant.id,
          bundleId: null,
          selection: null,
          productName: variant.product.name,
          variantName: variant.name,
          sku: variant.sku,
          hsnCode: variant.hsnCode,
          onePerCustomer: variant.product.onePerCustomer,
        };
      }

      const bundle = bundleById.get(item.bundleId);
      if (!bundle) return unavailable(item.key, 'This bundle is no longer available');
      const allowed = new Set(bundle.items.map((i) => i.variantId));
      const picks = item.selection.map((id) => variantById.get(id));
      if (
        item.selection.length !== bundle.slots ||
        picks.some((v, i) => !v || !allowed.has(item.selection[i]!))
      ) {
        return unavailable(item.key, `Pick ${bundle.slots} available packs for this bundle`);
      }
      return {
        key: item.key,
        unitPricePaise: bundle.pricePaise,
        quantity: item.quantity,
        gstRateBps: bundle.gstRateBps,
        discountable: true,
        walletEligible: false,
        productId: null,
        variantId: null,
        bundleId: bundle.id,
        selection: [...item.selection],
        productName: bundle.name,
        variantName: picks.map((v) => v!.product.name).join(' + '),
        sku: bundle.sku,
        hsnCode: bundle.hsnCode,
        onePerCustomer: false,
      };
    });
  }

  /**
   * Validity checks that need the database: active, date window, total and per-customer
   * limits. The minimum order value is checked by the engine (it depends on the cart).
   * Limits are re-checked atomically when the order is confirmed.
   */
  async resolveDiscount(
    rawCode: string,
    customerId: string | null,
    now: Date,
  ): Promise<{ pricing: PricingDiscount; applied: AppliedDiscount }> {
    const code = rawCode.trim().toUpperCase();
    const discount = await this.prisma.discount.findUnique({ where: { code } });
    if (
      !discount ||
      !discount.isActive ||
      (discount.startsAt && discount.startsAt > now) ||
      (discount.endsAt && discount.endsAt <= now)
    ) {
      throw new AppException(
        ErrorCode.DISCOUNT_INVALID,
        'This code is invalid or has expired.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (discount.usageLimit !== null) {
      const used = await this.prisma.discountRedemption.count({
        where: { discountId: discount.id },
      });
      if (used >= discount.usageLimit) throw notApplicable('This code has been fully redeemed.');
    }
    if (discount.perCustomerLimit !== null && customerId) {
      const usedByCustomer = await this.prisma.discountRedemption.count({
        where: { discountId: discount.id, customerId },
      });
      if (usedByCustomer >= discount.perCustomerLimit) {
        throw notApplicable('You have already used this code.');
      }
    }

    const pricing: PricingDiscount =
      discount.type === 'percentage'
        ? {
            type: 'percentage',
            valueBps: discount.valueBps ?? 0,
            maxDiscountPaise: discount.maxDiscountPaise,
            minSubtotalPaise: discount.minSubtotalPaise,
          }
        : {
            type: 'fixed',
            valuePaise: discount.valuePaise ?? 0,
            minSubtotalPaise: discount.minSubtotalPaise,
          };
    return { pricing, applied: { id: discount.id, code: discount.code } };
  }
}

function unavailable(key: string, message: string): AppException {
  return new AppException(ErrorCode.ITEM_UNAVAILABLE, message, HttpStatus.UNPROCESSABLE_ENTITY, {
    key,
  });
}

function notApplicable(message: string): AppException {
  return new AppException(
    ErrorCode.DISCOUNT_NOT_APPLICABLE,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function toAppException(err: unknown): unknown {
  if (!(err instanceof PricingError)) return err;
  if (err.reason === 'COD_DISABLED') {
    return new AppException(
      ErrorCode.COD_UNAVAILABLE,
      'Cash on Delivery is not available right now.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return new AppException(ErrorCode.BAD_REQUEST, err.message, HttpStatus.BAD_REQUEST);
}
