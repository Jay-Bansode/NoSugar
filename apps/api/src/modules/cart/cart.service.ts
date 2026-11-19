import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AddCartItem,
  type Cart,
  type CartLine,
  type CartLineIssue,
  ErrorCode,
  formatINR,
  MAX_CART_LINES,
  MAX_ITEM_QUANTITY,
  type PaymentMethod,
} from '@brand/shared';
import { AppException } from '../../common/app.exception.js';
import { RateLimiterService } from '../../common/rate-limiter.service.js';
import { ENV, type Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { CatalogMapper } from '../catalog/catalog.mapper.js';
import {
  type AppliedDiscount,
  PricingService,
  type PricingItem,
  type ResolvedLine,
} from '../pricing/pricing.service.js';
import { lineKey, type NewLine, planMerge, variantDemand } from './cart-lines.js';

/** Who is asking: a logged-in customer, a guest with a cart id, or a guest without one. */
export interface CartContext {
  customerId: string | null;
  guestCartId: string | null;
  ip: string;
}

type Tx = Prisma.TransactionClient;
type CartWithItems = Prisma.CartGetPayload<{ include: { items: true } }>;

const GUEST_CART_CREATION = { name: 'cart:create:ip', limit: 30, windowSeconds: 60 * 60 };
/** Statuses that don't count as "bought" for one-per-customer items. */
const NOT_PURCHASED = ['cancelled', 'payment_failed'] as const;

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);
  private readonly mapper: CatalogMapper;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly settings: SettingsService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(ENV) env: Env,
  ) {
    this.mapper = new CatalogMapper(env.CDN_BASE_URL ?? '/media');
  }

  // ───────────────────────────── Reads ─────────────────────────────

  async get(ctx: CartContext, paymentMethod: PaymentMethod): Promise<Cart> {
    const cart = await this.prisma.$transaction((tx) => this.findCart(tx, ctx, false));
    return this.view(cart, ctx.customerId, paymentMethod);
  }

  // ─────────────────────────── Mutations ───────────────────────────

  async addItem(ctx: CartContext, item: AddCartItem): Promise<Cart> {
    const cart = await this.prisma.$transaction(async (tx) => {
      const cart = (await this.findCart(tx, ctx, true))!;
      const identity = toIdentity(item);
      const existing = cart.items.find((line) => lineKey(toNewLine(line)) === lineKey(identity));
      const quantity = (existing?.quantity ?? 0) + item.quantity;
      if (!existing && cart.items.length >= MAX_CART_LINES) {
        throw new AppException(
          ErrorCode.CART_FULL,
          `A cart can hold up to ${MAX_CART_LINES} different items.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (quantity > MAX_ITEM_QUANTITY) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          `You can add up to ${MAX_ITEM_QUANTITY} of an item.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const others = cart.items.filter((line) => line.id !== existing?.id);
      await this.assertCanHold(ctx.customerId, { ...identity, quantity }, others);

      if (existing) {
        await tx.cartItem.update({ where: { id: existing.id }, data: { quantity } });
      } else {
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            variantId: identity.variantId,
            bundleId: identity.bundleId,
            bundleSelection: identity.selection ?? undefined,
            quantity,
          },
        });
      }
      await touch(tx, cart.id);
      return this.reload(tx, cart.id);
    });
    return this.view(cart, ctx.customerId, 'prepaid');
  }

  async updateItem(ctx: CartContext, itemId: string, quantity: number): Promise<Cart> {
    const cart = await this.prisma.$transaction(async (tx) => {
      const cart = await this.requireCart(tx, ctx);
      const line = cart.items.find((l) => l.id === itemId);
      if (!line) throw itemNotFound();
      const identity = {
        variantId: line.variantId,
        bundleId: line.bundleId,
        selection: selectionOf(line),
      };
      await this.assertCanHold(
        ctx.customerId,
        { ...identity, quantity },
        cart.items.filter((l) => l.id !== itemId),
      );
      await tx.cartItem.update({ where: { id: itemId }, data: { quantity } });
      await touch(tx, cart.id);
      return this.reload(tx, cart.id);
    });
    return this.view(cart, ctx.customerId, 'prepaid');
  }

  async removeItem(ctx: CartContext, itemId: string): Promise<Cart> {
    const cart = await this.prisma.$transaction(async (tx) => {
      const cart = await this.requireCart(tx, ctx);
      const { count } = await tx.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
      if (count === 0) throw itemNotFound();
      await touch(tx, cart.id);
      return this.reload(tx, cart.id);
    });
    return this.view(cart, ctx.customerId, 'prepaid');
  }

  /** Saves a discount code after checking it is valid now; null removes it. */
  async setDiscountCode(ctx: CartContext, code: string | null): Promise<Cart> {
    let normalized: string | null = null;
    if (code !== null) {
      // Throws DISCOUNT_INVALID / DISCOUNT_NOT_APPLICABLE; nothing is saved then.
      normalized = (await this.pricing.resolveDiscount(code, ctx.customerId, new Date())).applied
        .code;
    }
    const cart = await this.prisma.$transaction(async (tx) => {
      const cart = await this.requireCart(tx, ctx);
      await tx.cart.update({ where: { id: cart.id }, data: { discountCode: normalized } });
      return this.reload(tx, cart.id);
    });
    return this.view(cart, ctx.customerId, 'prepaid');
  }

  async clear(ctx: CartContext): Promise<Cart> {
    const cart = await this.prisma.$transaction(async (tx) => {
      const cart = await this.findCart(tx, ctx, false);
      if (!cart) return null;
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { discountCode: null } });
      return this.reload(tx, cart.id);
    });
    return this.view(cart, ctx.customerId, 'prepaid');
  }

  // ─────────────────────── Finding & merging ───────────────────────

  /**
   * Returns the cart for this context, locked for the rest of the transaction.
   * A customer request carrying a guest cart id merges that guest cart first (CLAUDE.md §6).
   */
  private async findCart(tx: Tx, ctx: CartContext, create: boolean): Promise<CartWithItems | null> {
    if (ctx.customerId) {
      const guest = ctx.guestCartId
        ? await lockCart(tx, { id: ctx.guestCartId, userId: null })
        : null;
      let cart = await lockCart(tx, { userId: ctx.customerId });
      if (!cart && (create || guest)) {
        await tx.cart.upsert({
          where: { userId: ctx.customerId },
          create: { userId: ctx.customerId },
          update: {},
        });
        cart = await lockCart(tx, { userId: ctx.customerId });
      }
      if (cart && guest) cart = await this.mergeGuestCart(tx, cart, guest, ctx.customerId);
      return cart;
    }

    if (ctx.guestCartId) {
      const cart = await lockCart(tx, { id: ctx.guestCartId, userId: null });
      // Unknown, expired, or now owned by a customer (merged): the client should drop the id.
      if (!cart) throw cartNotFound();
      return cart;
    }
    if (!create) return null;
    await this.rateLimiter.consume(GUEST_CART_CREATION, ctx.ip);
    const created = await tx.cart.create({ data: {} });
    return lockCart(tx, { id: created.id });
  }

  private async requireCart(tx: Tx, ctx: CartContext): Promise<CartWithItems> {
    const cart = await this.findCart(tx, ctx, false);
    if (!cart) throw cartNotFound();
    return cart;
  }

  private async mergeGuestCart(
    tx: Tx,
    cart: CartWithItems,
    guest: CartWithItems,
    customerId: string,
  ): Promise<CartWithItems> {
    const source: NewLine[] = guest.items.map((line) => ({
      variantId: line.variantId,
      bundleId: line.bundleId,
      selection: selectionOf(line),
      quantity: line.quantity,
    }));
    const onePerCustomer = await this.onePerCustomerVariantIds(
      source.map((l) => l.variantId).filter((id): id is string => id !== null),
    );
    const plan = planMerge(
      cart.items.map((line) => ({
        id: line.id,
        variantId: line.variantId,
        bundleId: line.bundleId,
        selection: selectionOf(line),
        quantity: line.quantity,
      })),
      source,
      {
        maxLines: MAX_CART_LINES,
        maxQuantity: (line) =>
          line.variantId && onePerCustomer.has(line.variantId) ? 1 : MAX_ITEM_QUANTITY,
      },
    );
    for (const update of plan.updates) {
      await tx.cartItem.update({ where: { id: update.id }, data: { quantity: update.quantity } });
    }
    if (plan.creates.length > 0) {
      await tx.cartItem.createMany({
        data: plan.creates.map((line) => ({
          cartId: cart.id,
          variantId: line.variantId,
          bundleId: line.bundleId,
          bundleSelection: line.selection ? [...line.selection] : undefined,
          quantity: line.quantity,
        })),
      });
    }
    // Keep the guest's code if the customer had none; it is re-validated when priced.
    if (!cart.discountCode && guest.discountCode) {
      await tx.cart.update({ where: { id: cart.id }, data: { discountCode: guest.discountCode } });
    }
    await tx.cart.delete({ where: { id: guest.id } });
    this.logger.log(
      `Merged guest cart (customerId=${customerId}, lines=${guest.items.length}, dropped=${plan.dropped})`,
    );
    return this.reload(tx, cart.id);
  }

  private async reload(tx: Tx, cartId: string): Promise<CartWithItems> {
    return tx.cart.findUniqueOrThrow({
      where: { id: cartId },
      include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
  }

  // ──────────────────────────── Rules ──────────────────────────────

  /**
   * Checks that `line` (at its new quantity) can sit in the cart next to `others`: the item
   * is sellable, one-per-customer limits hold and the whole cart's demand fits current stock.
   */
  private async assertCanHold(
    customerId: string | null,
    line: NewLine,
    others: CartWithItems['items'],
  ): Promise<void> {
    const [resolved] = await this.pricing.resolveEach([toPricingItem('new', line)]);
    if (!resolved || resolved instanceof AppException) throw resolved;

    if (resolved.onePerCustomer) {
      if (line.quantity > 1) throw purchaseLimit();
      if (customerId && resolved.productId) {
        const bought = await this.purchasedProductIds(customerId, [resolved.productId]);
        if (bought.has(resolved.productId)) throw purchaseLimit();
      }
    }

    const demand = variantDemand([
      line,
      ...others.map((o) => ({
        variantId: o.variantId,
        bundleId: o.bundleId,
        selection: selectionOf(o),
        quantity: o.quantity,
      })),
    ]);
    const lineVariants = new Set(variantDemand([line]).keys());
    const available = await this.availableStock([...lineVariants]);
    for (const variantId of lineVariants) {
      if ((demand.get(variantId) ?? 0) > (available.get(variantId) ?? 0)) {
        // Never reveal the exact stock left.
        throw new AppException(
          ErrorCode.OUT_OF_STOCK,
          'Not enough stock for that quantity.',
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private async availableStock(variantIds: string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.prisma.variant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, stock: true, reservedStock: true },
    });
    return new Map(rows.map((r) => [r.id, r.stock - r.reservedStock]));
  }

  private async onePerCustomerVariantIds(variantIds: string[]): Promise<Set<string>> {
    if (variantIds.length === 0) return new Set();
    const rows = await this.prisma.variant.findMany({
      where: { id: { in: variantIds }, product: { onePerCustomer: true } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** One-per-customer products this customer already ordered (any non-failed order). */
  async purchasedProductIds(customerId: string, productIds: string[]): Promise<Set<string>> {
    if (productIds.length === 0) return new Set();
    const rows = await this.prisma.orderItem.findMany({
      where: {
        order: { customerId, status: { notIn: [...NOT_PURCHASED] } },
        variant: { productId: { in: productIds } },
      },
      select: { variant: { select: { productId: true } } },
    });
    return new Set(rows.flatMap((r) => (r.variant ? [r.variant.productId] : [])));
  }

  // ──────────────────────────── View ───────────────────────────────

  private async view(
    cart: CartWithItems | null,
    customerId: string | null,
    requestedMethod: PaymentMethod,
  ): Promise<Cart> {
    const settings = await this.settings.getAll();
    const codAvailable = settings['cod.enabled'];
    const paymentMethod = requestedMethod === 'cod' && !codAvailable ? 'prepaid' : requestedMethod;
    const empty: Cart = {
      id: cart?.id ?? null,
      isGuest: !customerId,
      lines: [],
      discountCode: cart?.discountCode ?? null,
      discountMessage: null,
      paymentMethod,
      codAvailable,
      totals: null,
    };
    if (!cart || cart.items.length === 0) return empty;

    const results = await this.pricing.resolveEach(
      cart.items.map((line) => toPricingItem(line.id, toNewLine(line))),
    );
    const resolvedById = new Map<string, ResolvedLine>();
    results.forEach((r) => {
      if (!(r instanceof AppException)) resolvedById.set(r.key, r);
    });

    // Issues: unavailable, out of stock (each line on its own), already bought.
    const allVariantIds = [...variantDemand(cart.items.map(toNewLine)).keys()];
    const available = await this.availableStock(allVariantIds);
    const limitedProducts = [...resolvedById.values()]
      .filter((r) => r.onePerCustomer && r.productId)
      .map((r) => r.productId!);
    const bought = customerId
      ? await this.purchasedProductIds(customerId, limitedProducts)
      : new Set<string>();

    const issues = new Map<string, CartLineIssue>();
    for (const line of cart.items) {
      const resolved = resolvedById.get(line.id);
      if (!resolved) {
        issues.set(line.id, 'UNAVAILABLE');
        continue;
      }
      if (resolved.onePerCustomer && (line.quantity > 1 || bought.has(resolved.productId ?? ''))) {
        issues.set(line.id, 'PURCHASE_LIMIT');
        continue;
      }
      const need = variantDemand([toNewLine(line)]);
      if ([...need].some(([variantId, qty]) => qty > (available.get(variantId) ?? 0))) {
        issues.set(line.id, 'OUT_OF_STOCK');
      }
    }

    // Discount: re-validated every time; a bad code is reported, not fatal.
    let discount: Awaited<ReturnType<PricingService['resolveDiscount']>> | null = null;
    let discountMessage: string | null = null;
    if (cart.discountCode) {
      try {
        discount = await this.pricing.resolveDiscount(cart.discountCode, customerId, new Date());
      } catch (err) {
        if (!(err instanceof AppException)) throw err;
        discountMessage = err.message;
      }
    }

    const sellable = cart.items
      .filter((line) => !issues.has(line.id))
      .map((line) => resolvedById.get(line.id)!);
    let priced: Map<string, { unit: number; total: number }> = new Map();
    let totals: Cart['totals'] = null;
    if (sellable.length > 0) {
      const result = await this.pricing.price(sellable, {
        paymentMethod,
        discount,
        walletAvailablePaise: 0, // Phase 3: wallet balance
      });
      const q = result.quote;
      const applied: AppliedDiscount | null = result.discount;
      priced = new Map(
        q.lines.map((l) => [l.key, { unit: l.unitPricePaise, total: l.lineTotalPaise }]),
      );
      totals = {
        subtotalPaise: q.subtotalPaise,
        discountPaise: q.discountPaise,
        walletPaise: q.walletPaise,
        shippingPaise: q.shippingPaise,
        codFeePaise: q.codFeePaise,
        taxPaise: q.taxPaise,
        totalPaise: q.totalPaise,
        amountToFreeShippingPaise: q.amountToFreeShippingPaise,
      };
      if (discount && q.discountBelowMinimum) {
        const short = discount.pricing.minSubtotalPaise - q.subtotalPaise;
        discountMessage = `Add ${formatINR(short)} more to use ${discount.applied.code}.`;
      } else if (discount && !applied) {
        discountMessage = `${discount.applied.code} doesn't apply to the items in your cart.`;
      }
    }

    const display = await this.displayInfo(cart.items);
    const lines: CartLine[] = cart.items.map((line) => {
      const resolved = resolvedById.get(line.id);
      const info = display.get(line.id);
      const price = priced.get(line.id);
      return {
        id: line.id,
        kind: line.variantId ? 'variant' : 'bundle',
        variantId: line.variantId,
        bundleId: line.bundleId,
        selection: selectionOf(line),
        slug: info?.slug ?? null,
        name: resolved?.productName ?? info?.name ?? 'Unavailable item',
        variantName: resolved?.variantName ?? info?.variantName ?? '',
        image: info?.image ?? null,
        quantity: line.quantity,
        unitPricePaise: price?.unit ?? resolved?.unitPricePaise ?? null,
        lineTotalPaise: price?.total ?? null,
        issue: issues.get(line.id) ?? null,
      };
    });

    return { ...empty, lines, discountMessage, totals };
  }

  /** Slug, names and image for every line, including ones that are no longer sellable. */
  private async displayInfo(items: CartWithItems['items']) {
    const variantIds = items.flatMap((i) => (i.variantId ? [i.variantId] : []));
    const bundleIds = items.flatMap((i) => (i.bundleId ? [i.bundleId] : []));
    const [variants, bundles] = await Promise.all([
      this.prisma.variant.findMany({
        where: { id: { in: variantIds } },
        select: {
          id: true,
          name: true,
          product: {
            select: {
              slug: true,
              name: true,
              media: { orderBy: [{ position: 'asc' }, { id: 'asc' }], take: 1 },
            },
          },
        },
      }),
      this.prisma.bundle.findMany({
        where: { id: { in: bundleIds } },
        select: { id: true, slug: true, name: true },
      }),
    ]);
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const bundleById = new Map(bundles.map((b) => [b.id, b]));
    const info = new Map<
      string,
      { slug: string; name: string; variantName: string; image: CartLine['image'] }
    >();
    for (const item of items) {
      if (item.variantId) {
        const v = variantById.get(item.variantId);
        if (!v) continue;
        const media = v.product.media[0];
        info.set(item.id, {
          slug: v.product.slug,
          name: v.product.name,
          variantName: v.name,
          image: media ? this.mapper.media(media) : null,
        });
      } else if (item.bundleId) {
        const bundle = bundleById.get(item.bundleId);
        if (bundle)
          info.set(item.id, { slug: bundle.slug, name: bundle.name, variantName: '', image: null });
      }
    }
    return info;
  }
}

// ─────────────────────────── Helpers ───────────────────────────────

/** Locks the matching cart row (SELECT … FOR UPDATE) and returns it with its items. */
async function lockCart(
  tx: Tx,
  where: { id?: string; userId?: string | null },
): Promise<CartWithItems | null> {
  const found = await tx.cart.findFirst({ where, select: { id: true } });
  if (!found) return null;
  await tx.$queryRaw`SELECT id FROM carts WHERE id = ${found.id}::uuid FOR UPDATE`;
  return tx.cart.findUnique({
    where: { id: found.id },
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
}

async function touch(tx: Tx, cartId: string): Promise<void> {
  await tx.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
}

function selectionOf(line: { bundleSelection: Prisma.JsonValue | null }): string[] | null {
  const value = line.bundleSelection;
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null;
}

function toNewLine(line: CartWithItems['items'][number]): NewLine {
  return {
    variantId: line.variantId,
    bundleId: line.bundleId,
    selection: selectionOf(line),
    quantity: line.quantity,
  };
}

function toIdentity(item: AddCartItem): NewLine {
  return 'variantId' in item
    ? { variantId: item.variantId, bundleId: null, selection: null, quantity: item.quantity }
    : {
        variantId: null,
        bundleId: item.bundleId,
        selection: item.selection,
        quantity: item.quantity,
      };
}

function toPricingItem(key: string, line: NewLine): PricingItem {
  return line.variantId
    ? { key, variantId: line.variantId, quantity: line.quantity }
    : {
        key,
        bundleId: line.bundleId!,
        quantity: line.quantity,
        selection: [...(line.selection ?? [])],
      };
}

function cartNotFound(): AppException {
  return new AppException(
    ErrorCode.CART_NOT_FOUND,
    'Cart not found. Start a new cart.',
    HttpStatus.NOT_FOUND,
  );
}

function itemNotFound(): AppException {
  return new AppException(ErrorCode.NOT_FOUND, 'Cart item not found', HttpStatus.NOT_FOUND);
}

function purchaseLimit(): AppException {
  return new AppException(
    ErrorCode.PURCHASE_LIMIT,
    'The trial kit is limited to one per customer.',
    HttpStatus.CONFLICT,
  );
}
