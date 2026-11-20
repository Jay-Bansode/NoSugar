import { Module } from '@nestjs/common';
import { InvoicingService } from './invoicing.service.js';

/** GST invoices and credit notes. The PDF routes live with orders (/v1/orders/:number/…). */
@Module({
  providers: [InvoicingService],
  exports: [InvoicingService],
})
export class InvoicingModule {}
