import {
  Body,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  type AdminCancelOrder,
  adminCancelOrderSchema,
  type AdminOrderDetail,
  type AdminOrderListQuery,
  adminOrderListQuerySchema,
  type AdminOrderSummary,
  type AdminRefund,
  adminRefundSchema,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  orderNumberSchema,
  type Paginated,
} from '@brand/shared';
import { z } from 'zod';
import { AppException } from '../../common/app.exception.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  type AdminContext,
  AdminController,
  AdminRoles,
  ALL_ADMIN_ROLES,
  CurrentAdmin,
} from '../admin/admin.guard.js';
import type { PdfFile } from '../invoicing/invoicing.service.js';
import { AdminOrdersService } from './admin-orders.service.js';

const numberPipe = new ZodValidationPipe(orderNumberSchema);

function pdf(file: PdfFile | null, what: string): StreamableFile {
  if (!file) {
    throw new AppException(
      ErrorCode.INVOICE_NOT_AVAILABLE,
      `No ${what} for this order yet.`,
      HttpStatus.NOT_FOUND,
    );
  }
  return new StreamableFile(file.pdf, {
    type: 'application/pdf',
    disposition: `attachment; filename="${file.filename}"`,
    length: file.pdf.length,
  });
}

/**
 * /v1/admin/orders. Everyone on staff can look up orders and cancel before dispatch (support
 * answers customers); owners and operations pack; only owners refund after delivery.
 */
@AdminController('orders', ALL_ADMIN_ROLES)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query(new ZodValidationPipe(adminOrderListQuerySchema)) query: AdminOrderListQuery,
  ): Promise<Paginated<AdminOrderSummary>> {
    return this.orders.list(query);
  }

  @Get(':number')
  @Header('Cache-Control', 'no-store')
  detail(@Param('number', numberPipe) number: string): Promise<AdminOrderDetail> {
    return this.orders.detail(number);
  }

  @Post(':number/pack')
  @HttpCode(200)
  @AdminRoles('owner', 'operations')
  pack(
    @CurrentAdmin() admin: AdminContext,
    @Param('number', numberPipe) number: string,
  ): Promise<AdminOrderDetail> {
    return this.orders.pack(admin, number);
  }

  @Post(':number/cancel')
  @HttpCode(200)
  cancel(
    @CurrentAdmin() admin: AdminContext,
    @Param('number', numberPipe) number: string,
    @Body(new ZodValidationPipe(adminCancelOrderSchema)) body: AdminCancelOrder,
  ): Promise<AdminOrderDetail> {
    return this.orders.cancel(admin, number, body.reason);
  }

  @Post(':number/refunds')
  @HttpCode(200)
  @AdminRoles('owner')
  refund(
    @CurrentAdmin() admin: AdminContext,
    @Param('number', numberPipe) number: string,
    @Headers(IDEMPOTENCY_KEY_HEADER) rawKey: string | undefined,
    @Body(new ZodValidationPipe(adminRefundSchema)) body: AdminRefund,
  ): Promise<AdminOrderDetail> {
    // Required: a double click or a retried request must never refund twice.
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        'An Idempotency-Key header (UUID) is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.orders.refund(admin, number, body, key.data);
  }

  @Get(':number/invoice')
  @Header('Cache-Control', 'private, no-store')
  async invoice(@Param('number', numberPipe) number: string): Promise<StreamableFile> {
    return pdf(await this.orders.invoicePdf(number), 'invoice');
  }

  @Get(':number/credit-notes/:id')
  @Header('Cache-Control', 'private, no-store')
  async creditNote(
    @Param('number', numberPipe) number: string,
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<StreamableFile> {
    return pdf(await this.orders.creditNotePdf(number, id), 'credit note');
  }
}
