import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  cursorQuerySchema,
  ErrorCode,
  type OrderDetail,
  orderNumberSchema,
  type OrderSummary,
  type Paginated,
} from '@brand/shared';
import { z } from 'zod';
import { AppException } from '../../common/app.exception.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentAuth } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/token.service.js';
import { InvoicingService, type PdfFile } from '../invoicing/invoicing.service.js';
import { OrdersService } from './orders.service.js';

const listQuerySchema = cursorQuerySchema.extend({ cursor: z.uuid().optional() });
const numberPipe = new ZodValidationPipe(orderNumberSchema);
const uuidPipe = new ZodValidationPipe(z.uuid());

function pdfResponse(file: PdfFile | null): StreamableFile {
  if (!file) {
    throw new AppException(
      ErrorCode.INVOICE_NOT_AVAILABLE,
      'The invoice isn’t available yet. Please try again in a few minutes.',
      HttpStatus.NOT_FOUND,
    );
  }
  return new StreamableFile(file.pdf, {
    type: 'application/pdf',
    disposition: `attachment; filename="${file.filename}"`,
    length: file.pdf.length,
  });
}

/** The logged-in customer's own orders. Other customers' orders are 404, never 403. */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly invoicing: InvoicingService,
  ) {}

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

  /** GST invoice PDF (CLAUDE.md §7). */
  @Get(':number/invoice')
  @Header('Cache-Control', 'private, no-store')
  async invoice(
    @CurrentAuth() auth: AuthContext,
    @Param('number', numberPipe) number: string,
  ): Promise<StreamableFile> {
    const orderId = await this.orders.ownOrderId(auth.userId, number);
    return pdfResponse(await this.invoicing.invoicePdf(orderId));
  }

  /** Credit note PDF; ids are listed in the order detail's `creditNotes`. */
  @Get(':number/credit-notes/:id')
  @Header('Cache-Control', 'private, no-store')
  async creditNote(
    @CurrentAuth() auth: AuthContext,
    @Param('number', numberPipe) number: string,
    @Param('id', uuidPipe) id: string,
  ): Promise<StreamableFile> {
    const orderId = await this.orders.ownOrderId(auth.userId, number);
    const file = await this.invoicing.creditNotePdf(orderId, id);
    if (!file)
      throw new AppException(ErrorCode.NOT_FOUND, 'Credit note not found', HttpStatus.NOT_FOUND);
    return pdfResponse(file);
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
