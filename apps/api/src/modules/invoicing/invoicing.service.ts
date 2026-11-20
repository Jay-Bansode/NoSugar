import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  buildInvoiceLines,
  CREDIT_NOTE_PREFIX,
  type CreditNoteLine,
  creditNoteLines,
  type DocumentLine,
  documentNumber,
  financialYear,
  INVOICE_PREFIX,
  type OrderStatus,
  type Paise,
  shippingAddressSchema,
  stateName,
  sumLines,
} from '@brand/shared';
import { ENV, type Env } from '../../config/env.js';
import type { InvoiceSeriesKind, Prisma } from '../../generated/prisma/client.js';
import { JobsService } from '../../jobs/jobs.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { type Party, renderTaxDocument, type TaxDocumentView } from './pdf/tax-document-pdf.js';
import { type Seller, sellerFromEnv } from './seller.js';

export const ISSUE_INVOICE_JOB = 'issue-invoice';
const SWEEP_JOB = 'issue-missing-invoices';
const SWEEP_EVERY_MS = 5 * 60_000;
const SWEEP_BATCH = 100;

type Tx = Prisma.TransactionClient;

/** Orders that have been sold and not reversed. Cancelled/returned orders get credit notes. */
const INVOICEABLE: readonly OrderStatus[] = [
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'undelivered',
  'delivered',
];

/** Seller fields kept in the invoice's `seller` JSON (GSTIN and state code are columns). */
interface SellerSnapshot {
  legalName: string;
  address: string;
  fssaiLicenceNo: string;
}

interface BuyerSnapshot {
  name: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
}

export interface IssuedDocument {
  id: string;
  number: string;
}

export interface PdfFile {
  filename: string;
  pdf: Buffer;
}

// Snapshots are written only by this service and never change (DB trigger), so reading them
// back with a cast is safe.
const asLines = (json: Prisma.JsonValue) => json as unknown as DocumentLine[];
const asCreditLines = (json: Prisma.JsonValue) => json as unknown as CreditNoteLine[];
const toJson = (value: object) => value as Prisma.InputJsonValue;

/**
 * GST invoices and credit notes (CLAUDE.md §8). Numbers come from a per-financial-year series
 * row locked inside the issuing transaction, so they are sequential with no gaps. Documents
 * are immutable snapshots; PDFs are rendered from them on request.
 *
 *   - Invoice: issued by a background job once the order is confirmed (prepaid paid, or COD
 *     placed). A sweep every few minutes catches any order whose job never ran.
 *   - Credit note: issued for whatever is still uncredited when an invoiced order is cancelled
 *     or returned (OrdersService.transition), or for a given amount on a partial refund.
 */
@Injectable()
export class InvoicingService implements OnModuleInit {
  private readonly logger = new Logger(InvoicingService.name);
  private readonly seller: Seller;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(ENV) env: Env,
  ) {
    this.seller = sellerFromEnv(env);
  }

  onModuleInit(): void {
    this.jobs.register(ISSUE_INVOICE_JOB, async (data) => {
      await this.issueInvoice(String(data.orderId));
    });
    this.jobs.schedule(SWEEP_JOB, SWEEP_EVERY_MS, async () => {
      const issued = await this.issueMissingInvoices();
      if (issued > 0) this.logger.warn(`Sweep issued ${issued} missing invoice(s)`);
    });
  }

  /**
   * Queues the invoice for a just-confirmed order. Call after the confirming transaction has
   * committed. Never throws: if queueing fails, the sweep issues the invoice later.
   */
  async queueInvoice(orderId: string): Promise<void> {
    try {
      await this.jobs.enqueue(ISSUE_INVOICE_JOB, { orderId }, `invoice-${orderId}`);
    } catch (err) {
      this.logger.warn(
        `Could not queue invoice (orderId=${orderId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Issues the order's invoice if it doesn't have one yet. Idempotent. Returns null (and
   * issues nothing) while the order isn't in a sold state. `now` decides the date and series.
   */
  async issueInvoice(orderId: string, now = new Date()): Promise<IssuedDocument | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: { orderBy: { id: 'asc' } }, invoice: true },
      });
      if (!order) {
        this.logger.warn(`No such order to invoice (orderId=${orderId})`);
        return null;
      }
      if (order.invoice) return { id: order.invoice.id, number: order.invoice.number };
      if (!INVOICEABLE.includes(order.status)) {
        this.logger.log(`No invoice for order in status ${order.status} (orderId=${orderId})`);
        return null;
      }

      const address = shippingAddressSchema.parse(order.shippingAddress);
      const lines = buildInvoiceLines({
        items: order.items,
        shippingPaise: order.shippingPaise,
        codFeePaise: order.codFeePaise,
        taxPaise: order.taxPaise,
        sellerStateCode: this.seller.stateCode,
        placeOfSupplyCode: address.stateCode,
      });
      const totals = sumLines(lines);
      // Wallet credit is a way of paying, so it is part of the invoice value.
      if (totals.totalPaise !== order.totalPaise + order.walletPaise) {
        throw new Error(`Invoice lines do not add up to the order (orderId=${orderId})`);
      }

      const { seriesId, sequence, number } = await this.nextNumber(
        tx,
        'invoice',
        INVOICE_PREFIX,
        now,
      );
      const seller: SellerSnapshot = {
        legalName: this.seller.legalName,
        address: this.seller.address,
        fssaiLicenceNo: this.seller.fssaiLicenceNo,
      };
      const buyer: BuyerSnapshot = {
        name: address.name,
        line1: address.line1,
        line2: address.line2,
        landmark: address.landmark,
        city: address.city,
        state: address.state,
        stateCode: address.stateCode,
        pincode: address.pincode,
      };
      const invoice = await tx.invoice.create({
        data: {
          orderId,
          seriesId,
          sequence,
          number,
          sellerGstin: this.seller.gstin,
          sellerStateCode: this.seller.stateCode,
          placeOfSupplyCode: address.stateCode,
          ...totals,
          seller: toJson(seller),
          buyer: toJson(buyer),
          lines: toJson(lines),
          issuedAt: now,
        },
      });
      this.logger.log(`Invoice ${number} issued (orderId=${orderId}, invoiceId=${invoice.id})`);
      return { id: invoice.id, number };
    });
  }

  /** Issues invoices for sold orders that don't have one (e.g. a lost job). */
  async issueMissingInvoices(): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: { status: { in: [...INVOICEABLE] }, invoice: null },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
    });
    let issued = 0;
    for (const { id } of orders) {
      try {
        if (await this.issueInvoice(id)) issued++;
      } catch (err) {
        this.logger.error(
          `Invoice failed (orderId=${id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return issued;
  }

  /**
   * Issues a credit note against the order's invoice, inside the caller's transaction (which
   * should hold the order row lock). `amountPaise` is tax-inclusive, or "remaining" for
   * everything not yet credited. Returns null when there is no invoice or nothing to credit.
   */
  async issueCreditNote(
    tx: Tx,
    orderId: string,
    options: { amountPaise: Paise | 'remaining'; reason: string; refundId?: string; now?: Date },
  ): Promise<IssuedDocument | null> {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const invoice = await tx.invoice.findUnique({
      where: { orderId },
      include: { creditNotes: { orderBy: { issuedAt: 'asc' } } },
    });
    if (!invoice) return null;
    const lines = creditNoteLines(
      asLines(invoice.lines),
      invoice.creditNotes.map((c) => asCreditLines(c.lines)),
      options.amountPaise,
    );
    if (lines.length === 0) return null;

    const now = options.now ?? new Date();
    const { seriesId, sequence, number } = await this.nextNumber(
      tx,
      'credit_note',
      CREDIT_NOTE_PREFIX,
      now,
    );
    const note = await tx.creditNote.create({
      data: {
        invoiceId: invoice.id,
        refundId: options.refundId ?? null,
        seriesId,
        sequence,
        number,
        ...sumLines(lines),
        reason: options.reason.slice(0, 500),
        lines: toJson(lines),
        issuedAt: now,
      },
    });
    this.logger.log(`Credit note ${number} issued (orderId=${orderId}, creditNoteId=${note.id})`);
    return { id: note.id, number };
  }

  async invoicePdf(orderId: string): Promise<PdfFile | null> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { orderId },
      include: { order: true },
    });
    if (!invoice) return null;
    const view: TaxDocumentView = {
      ...this.commonView(invoice),
      kind: 'invoice',
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      lines: asLines(invoice.lines),
      totals: invoice,
      payment: { method: invoice.order.paymentMethod, walletPaise: invoice.order.walletPaise },
    };
    return { filename: fileName(invoice.number), pdf: renderTaxDocument(view) };
  }

  async creditNotePdf(orderId: string, creditNoteId: string): Promise<PdfFile | null> {
    const note = await this.prisma.creditNote.findFirst({
      where: { id: creditNoteId, invoice: { orderId } },
      include: { invoice: { include: { order: true } } },
    });
    if (!note) return null;
    const view: TaxDocumentView = {
      ...this.commonView(note.invoice),
      kind: 'credit_note',
      number: note.number,
      issuedAt: note.issuedAt,
      lines: asCreditLines(note.lines),
      totals: note,
      against: {
        invoiceNumber: note.invoice.number,
        invoiceDate: note.invoice.issuedAt,
        reason: note.reason,
      },
    };
    return { filename: fileName(note.number), pdf: renderTaxDocument(view) };
  }

  private commonView(
    invoice: Prisma.InvoiceGetPayload<{ include: { order: true } }>,
  ): Pick<
    TaxDocumentView,
    'seller' | 'buyer' | 'placeOfSupply' | 'orderNumber' | 'orderDate' | 'specimen'
  > {
    const seller = invoice.seller as unknown as SellerSnapshot;
    const buyer = invoice.buyer as unknown as BuyerSnapshot;
    const party: Party = {
      name: buyer.name,
      lines: [
        buyer.line1,
        ...(buyer.line2 ? [buyer.line2] : []),
        ...(buyer.landmark ? [`Landmark: ${buyer.landmark}`] : []),
        `${buyer.city}, ${buyer.state} ${buyer.pincode}`,
      ],
    };
    return {
      seller: {
        ...seller,
        gstin: invoice.sellerGstin,
        stateCode: invoice.sellerStateCode,
      },
      buyer: party,
      placeOfSupply: {
        code: invoice.placeOfSupplyCode,
        name: stateName(invoice.placeOfSupplyCode) ?? invoice.placeOfSupplyCode,
      },
      orderNumber: invoice.order.number,
      orderDate: invoice.order.createdAt,
      specimen: this.seller.specimen,
    };
  }

  /**
   * Takes the next number in the series for `now`'s financial year. The series row stays
   * locked until the caller's transaction ends, so numbers are never skipped or reused.
   */
  private async nextNumber(
    tx: Tx,
    kind: InvoiceSeriesKind,
    prefix: string,
    now: Date,
  ): Promise<{ seriesId: string; sequence: number; number: string }> {
    const fy = financialYear(now);
    await tx.invoiceSeries.createMany({
      data: [{ kind, financialYear: fy, prefix }],
      skipDuplicates: true,
    });
    const [series] = await tx.$queryRaw<{ id: string; prefix: string; next_number: number }[]>`
      SELECT id, prefix, next_number FROM invoice_series
      WHERE kind = ${kind}::invoice_series_kind AND financial_year = ${fy}
      FOR UPDATE`;
    if (!series) throw new Error(`Invoice series ${kind} ${fy} is missing`);
    const number = documentNumber(series.prefix, fy, series.next_number);
    await tx.invoiceSeries.update({
      where: { id: series.id },
      data: { nextNumber: { increment: 1 } },
    });
    return { seriesId: series.id, sequence: series.next_number, number };
  }
}

/** "INV/26-27/000123" → "INV-26-27-000123.pdf" */
function fileName(number: string): string {
  return `${number.replace(/\//g, '-')}.pdf`;
}
