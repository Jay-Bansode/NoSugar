import {
  Body,
  Controller,
  createParamDecorator,
  Delete,
  type ExecutionContext,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type AddCartItem,
  addCartItemSchema,
  type Cart,
  CART_ID_HEADER,
  cartIdSchema,
  type CartQuery,
  cartQuerySchema,
  ErrorCode,
  type UpdateCart,
  type UpdateCartItem,
  updateCartItemSchema,
  updateCartSchema,
} from '@brand/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { AppException } from '../../common/app.exception.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OptionalAuth, OptionalCurrentAuth } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/token.service.js';
import { type CartContext, CartService } from './cart.service.js';

const itemIdPipe = new ZodValidationPipe(z.uuid());

/**
 * The guest cart id from `X-Cart-Id`. A malformed id can't match any cart, so it gets the
 * same CART_NOT_FOUND as an unknown one: the client drops it and starts a new cart.
 */
const CartIdHeader = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const raw = ctx.switchToHttp().getRequest<Request>().headers[CART_ID_HEADER];
  if (raw === undefined || raw === '') return undefined;
  const parsed = cartIdSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new AppException(
      ErrorCode.CART_NOT_FOUND,
      'Cart not found. Start a new cart.',
      HttpStatus.NOT_FOUND,
    );
  }
  return parsed.data;
});

/**
 * Cart for guests and customers. Guests send `X-Cart-Id` (returned as `id` after the first
 * item is added). Every response is the full cart, so clients just re-render.
 */
@OptionalAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(
    @OptionalCurrentAuth() auth: AuthContext | null,
    @CartIdHeader() cartId: string | undefined,
    @Query(new ZodValidationPipe(cartQuerySchema)) query: CartQuery,
    @Req() req: Request,
  ): Promise<Cart> {
    return this.cart.get(context(auth, cartId, req), query.paymentMethod);
  }

  /** Sets (or with null, removes) the discount code. */
  @Patch()
  @Header('Cache-Control', 'no-store')
  update(
    @OptionalCurrentAuth() auth: AuthContext | null,
    @CartIdHeader() cartId: string | undefined,
    @Body(new ZodValidationPipe(updateCartSchema)) body: UpdateCart,
    @Req() req: Request,
  ): Promise<Cart> {
    return this.cart.setDiscountCode(context(auth, cartId, req), body.discountCode);
  }

  /** Empties the cart. */
  @Delete()
  @Header('Cache-Control', 'no-store')
  clear(
    @OptionalCurrentAuth() auth: AuthContext | null,
    @CartIdHeader() cartId: string | undefined,
    @Req() req: Request,
  ): Promise<Cart> {
    return this.cart.clear(context(auth, cartId, req));
  }

  /** 200, not 201: the response is the whole cart, not the created line. */
  @Post('items')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  addItem(
    @OptionalCurrentAuth() auth: AuthContext | null,
    @CartIdHeader() cartId: string | undefined,
    @Body(new ZodValidationPipe(addCartItemSchema)) body: AddCartItem,
    @Req() req: Request,
  ): Promise<Cart> {
    return this.cart.addItem(context(auth, cartId, req), body);
  }

  @Patch('items/:itemId')
  @Header('Cache-Control', 'no-store')
  updateItem(
    @OptionalCurrentAuth() auth: AuthContext | null,
    @CartIdHeader() cartId: string | undefined,
    @Param('itemId', itemIdPipe) itemId: string,
    @Body(new ZodValidationPipe(updateCartItemSchema)) body: UpdateCartItem,
    @Req() req: Request,
  ): Promise<Cart> {
    return this.cart.updateItem(context(auth, cartId, req), itemId, body.quantity);
  }

  @Delete('items/:itemId')
  @Header('Cache-Control', 'no-store')
  removeItem(
    @OptionalCurrentAuth() auth: AuthContext | null,
    @CartIdHeader() cartId: string | undefined,
    @Param('itemId', itemIdPipe) itemId: string,
    @Req() req: Request,
  ): Promise<Cart> {
    return this.cart.removeItem(context(auth, cartId, req), itemId);
  }
}

function context(auth: AuthContext | null, cartId: string | undefined, req: Request): CartContext {
  return {
    customerId: auth?.userId ?? null,
    guestCartId: cartId ?? null,
    ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
  };
}
