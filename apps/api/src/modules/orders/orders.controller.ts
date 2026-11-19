import { Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  cursorQuerySchema,
  type OrderDetail,
  orderNumberSchema,
  type OrderSummary,
  type Paginated,
} from '@brand/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentAuth } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/token.service.js';
import { OrdersService } from './orders.service.js';

const listQuerySchema = cursorQuerySchema.extend({ cursor: z.uuid().optional() });
const numberPipe = new ZodValidationPipe(orderNumberSchema);

/** The logged-in customer's own orders. Other customers' orders are 404, never 403. */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<Paginated<OrderSummary>> {
    return this.orders.list(auth.userId, query);
  }

  @Get(':number')
  @Header('Cache-Control', 'no-store')
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('number', numberPipe) number: string,
  ): Promise<OrderDetail> {
    return this.orders.detail(auth.userId, number);
  }

  @Post(':number/cancel')
  @HttpCode(200)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('number', numberPipe) number: string,
  ): Promise<OrderDetail> {
    return this.orders.cancelByCustomer(auth.userId, number);
  }
}
