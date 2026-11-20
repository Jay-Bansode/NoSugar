/**
 * GST invoices and credit notes against real Postgres + Redis + BullMQ: issued by the job
 * after confirmation, CGST/SGST vs IGST, PDFs, credit notes on cancellation (full and after a
 * partial credit), gapless numbering under concurrency and rollback, immutability triggers.
 * Covers CLAUDE.md §10 "Partial refund → credit note amounts and GST split correct".
 * Run: pnpm --filter @brand/api test:db
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  addressInputSchema,
  type CreditNoteLine,
  type DocumentLine,
  errorResponseSchema,
  type OrderDetail,
  orderDetailSchema,
  sumLines,
  taxFromInclusive,
  toShippingAddress,
} from '@brand/shared';
import { randomInt, randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { loadEnv } from '../src/config/env.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { InvoicingService } from '../src/modules/invoicing/invoicing.service.js';
import { FakeGateway } from '../src/modules/payments/fake.gateway.js';
import { PAYMENT_GATEWAY } from '../src/modules/payments/gateway.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEST_ENV } from './helpers/env.js';
import { deleteTestOrders } from './helpers/orders.js';

const run = randomUUID().slice(0, 8).toUpperCase();
/** A financial year no real document will use, so numbering can be asserted exactly. */
const FUTURE = new Date('2099-06-01T00:00:00Z');
const FUTURE_FY = '2099-00';

let app: NestExpressApplication;
let prisma: PrismaService;
let invoicing: InvoicingService;
let gateway: FakeGateway;

const f = { productIds: [] as string[], userIds: [] as string[], fifteen: '', sku: '' };

const PUNE = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Pune',
  stateCode: '27',
  pincode: '411001',
};
const BENGALURU = {
  ...PUNE,
  line1: '5 Brigade Road',
  city: 'Bengaluru',
  stateCode: '29',
  pincode: '560001',
};

interface Customer {
  userId: string;
  token: string;
}

async function customer(): Promise<Customer> {
  const user = await prisma.user.create({
    data: { phone: `+9195${randomInt(10_000_000, 99_999_999)}` },
  });
  f.userIds.push(user.id);
  const { token } = await app
    .get(TokenService)
    .signAccessToken({ userId: user.id, sessionId: randomUUID() });
  return { userId: user.id, token };
}

const ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
function http(c: Customer, method: 'get' | 'post', path: string) {
  return request(app.getHttpServer())
    [method](path)
    .set('Authorization', `Bearer ${c.token}`)
    .set('X-Forwarded-For', ip());
}

/** Supertest doesn't buffer application/pdf by default. In Node the parser gets the raw stream. */
function binary(res: Response, done: (err: Error | null, body: Buffer) => void) {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
}

async function placeOrder(
  c: Customer,
  paymentMethod: 'cod' | 'prepaid',
  address = PUNE,
  quantity = 1,
): Promise<OrderDetail> {
  await http(c, 'post', '/v1/cart/items').send({ variantId: f.fifteen, quantity }).expect(200);
  const res = await http(c, 'post', '/v1/checkout')
    .set('Idempotency-Key', randomUUID())
    .send({ paymentMethod, address })
    .expect(201);
  return orderDetailSchema.parse(res.body);
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for background job');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const invoiceOf = (number: string) =>
  waitFor(() =>
    prisma.invoice.findFirst({
      where: { order: { number } },
      include: { creditNotes: { orderBy: { issuedAt: 'asc' } } },
    }),
  );

/** A confirmed COD order written straight to the database (no job queued). */
async function insertConfirmedOrder(customerId: string): Promise<string> {
  const lineTax = taxFromInclusive(69900, 500);
  const order = await prisma.order.create({
    data: {
      number: `T${run}${randomInt(100_000, 999_999)}`,
      customerId,
      status: 'confirmed',
      paymentMethod: 'cod',
      subtotalPaise: 69900,
      codFeePaise: 4900,
      taxPaise: lineTax + taxFromInclusive(4900, 500),
      totalPaise: 74800,
      shippingAddress: toShippingAddress(addressInputSchema.parse(PUNE)),
      idempotencyKey: randomUUID(),
      items: {
        create: {
          variantId: f.fifteen,
          productName: 'Test latte',
          variantName: '15 sachets',
          sku: f.sku,
          hsnCode: '2101',
          gstRateBps: 500,
          unitPricePaise: 69900,
          quantity: 1,
          lineTotalPaise: 69900,
          taxPaise: lineTax,
        },
      },
    },
  });
  return order.id;
}

/** Removes the test-only FY series and anything numbered from it (e.g. left by a failed run). */
async function purgeFutureSeries(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    const series = await tx.invoiceSeries.findMany({ where: { financialYear: FUTURE_FY } });
    const ids = series.map((s) => s.id);
    await tx.creditNote.deleteMany({ where: { seriesId: { in: ids } } });
    await tx.invoice.deleteMany({ where: { seriesId: { in: ids } } });
    await tx.invoiceSeries.deleteMany({ where: { id: { in: ids } } });
  });
}

beforeAll(async () => {
  const env = loadEnv({
    ...TEST_ENV,
    TRUST_PROXY: '1',
    DATABASE_URL: process.env.DATABASE_URL ?? TEST_ENV.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? TEST_ENV.REDIS_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
  app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true }),
  );
  await app.init();
  prisma = app.get(PrismaService);
  invoicing = app.get(InvoicingService);
  gateway = app.get<FakeGateway>(PAYMENT_GATEWAY);
  await purgeFutureSeries();

  f.sku = `T-${run}-FIFTEEN`;
  const product = await prisma.product.create({
    data: {
      slug: `t-${run.toLowerCase()}-invoice`,
      name: 'Test latte',
      type: 'coffee',
      variants: {
        create: {
          sku: f.sku,
          name: '15 sachets',
          packSize: 15,
          mrpPaise: 69900,
          pricePaise: 69900,
          hsnCode: '2101',
          gstRateBps: 500,
          stock: 200,
          weightG: 330,
        },
      },
    },
    include: { variants: true },
  });
  f.productIds.push(product.id);
  f.fifteen = product.variants[0]!.id;
});

afterAll(async () => {
  await deleteTestOrders(prisma, f.userIds);
  await purgeFutureSeries();
  await prisma.cart.deleteMany({ where: { userId: { in: f.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await prisma.variant.deleteMany({ where: { productId: { in: f.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: f.productIds } } });
  await app.close();
});

describe('invoice on confirmation', () => {
  it('invoices a COD order in the seller state with CGST + SGST, downloadable as a PDF', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod');
    expect(order.status).toBe('confirmed');
    const invoice = await invoiceOf(order.number);

    // ₹699 15-pack + ₹49 COD fee, both at 5%, Maharashtra → Maharashtra.
    expect(invoice.number).toMatch(/^INV\/\d{2}-\d{2}\/\d{6}$/);
    expect(invoice).toMatchObject({
      sellerGstin: '27ABCDE1234F1Z5',
      sellerStateCode: '27',
      placeOfSupplyCode: '27',
      igstPaise: 0,
      totalPaise: order.totals.totalPaise,
    });
    expect(invoice.cgstPaise + invoice.sgstPaise).toBe(order.totals.taxPaise);
    const lines = invoice.lines as unknown as DocumentLine[];
    expect(lines.map((l) => l.description)).toEqual([
      'Test latte - 15 sachets',
      'Cash on delivery fee',
    ]);
    expect(invoice.buyer).toEqual({
      name: 'Asha Rao',
      line1: '12 MG Road',
      line2: null,
      landmark: null,
      city: 'Pune',
      state: 'Maharashtra',
      stateCode: '27',
      pincode: '411001',
    });

    const detail = orderDetailSchema.parse(
      (await http(c, 'get', `/v1/orders/${order.number}`).expect(200)).body,
    );
    expect(detail.invoice).toEqual({
      number: invoice.number,
      issuedAt: invoice.issuedAt.toISOString(),
      totalPaise: invoice.totalPaise,
    });
    expect(detail.creditNotes).toEqual([]);

    const pdf = await http(c, 'get', `/v1/orders/${order.number}/invoice`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect(pdf.headers['content-disposition']).toBe(
      `attachment; filename="${invoice.number.replace(/\//g, '-')}.pdf"`,
    );
    const body = (pdf.body as Buffer).toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body).toContain(`(${invoice.number})`);
    expect(body).toContain('SPECIMEN');
  });

  it('invoices a prepaid order to another state with IGST only once it is paid', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'prepaid', BENGALURU);
    const early = await http(c, 'get', `/v1/orders/${order.number}/invoice`).expect(404);
    expect(errorResponseSchema.parse(early.body).error.code).toBe('INVOICE_NOT_AVAILABLE');
    expect(
      await invoicing.issueInvoice(
        (await prisma.order.findUniqueOrThrow({ where: { number: order.number } })).id,
      ),
    ).toBeNull();

    const { paymentId, signature } = gateway.simulatePayment(order.payment!.razorpayOrderId);
    await http(c, 'post', '/v1/payments/verify')
      .send({
        razorpayOrderId: order.payment!.razorpayOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      })
      .expect(200);
    const invoice = await invoiceOf(order.number);
    expect(invoice).toMatchObject({
      placeOfSupplyCode: '29',
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: taxFromInclusive(69900, 500),
      totalPaise: 69900,
    });
    expect(invoice.taxableValuePaise).toBe(69900 - invoice.igstPaise);
  });

  it("never shows one customer another customer's invoice", async () => {
    const owner = await customer();
    const order = await placeOrder(owner, 'cod');
    await invoiceOf(order.number);
    const stranger = await customer();
    const res = await http(stranger, 'get', `/v1/orders/${order.number}/invoice`).expect(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('is idempotent: issuing again returns the same invoice', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod');
    const invoice = await invoiceOf(order.number);
    expect(await invoicing.issueInvoice(invoice.orderId)).toEqual({
      id: invoice.id,
      number: invoice.number,
    });
    expect(await prisma.invoice.count({ where: { orderId: invoice.orderId } })).toBe(1);
  });
});

describe('credit notes', () => {
  it('cancelling an invoiced order credits it in full; the credit note PDF downloads', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod');
    const invoice = await invoiceOf(order.number);

    const res = await http(c, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    const cancelled = orderDetailSchema.parse(res.body);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.creditNotes).toHaveLength(1);
    const [summary] = cancelled.creditNotes;
    expect(summary!.number).toMatch(/^CN\/\d{2}-\d{2}\/\d{6}$/);
    expect(summary!.totalPaise).toBe(invoice.totalPaise);

    const note = await prisma.creditNote.findUniqueOrThrow({ where: { id: summary!.id } });
    expect(note).toMatchObject({
      invoiceId: invoice.id,
      taxableValuePaise: invoice.taxableValuePaise,
      cgstPaise: invoice.cgstPaise,
      sgstPaise: invoice.sgstPaise,
      igstPaise: 0,
      reason: 'Order cancelled (Cancelled by customer)',
    });

    const pdf = await http(c, 'get', `/v1/orders/${order.number}/credit-notes/${summary!.id}`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const body = (pdf.body as Buffer).toString('latin1');
    expect(body).toContain('(CREDIT NOTE)');
    expect(body).toContain(`(${invoice.number})`);

    await http(c, 'get', `/v1/orders/${order.number}/credit-notes/${randomUUID()}`).expect(404);
    await http(c, 'get', `/v1/orders/${order.number}/credit-notes/not-a-uuid`).expect(400);
  });

  it('after a partial credit note, cancelling credits exactly the rest (GST split included)', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod', PUNE, 2);
    const invoice = await invoiceOf(order.number);

    const partial = await prisma.$transaction((tx) =>
      invoicing.issueCreditNote(tx, invoice.orderId, {
        amountPaise: 33_333,
        reason: 'Partial refund',
      }),
    );
    expect(partial).not.toBeNull();
    const first = await prisma.creditNote.findUniqueOrThrow({ where: { id: partial!.id } });
    expect(first.totalPaise).toBe(33_333);
    // Tax is worked back out of the credited amount at 5%, split evenly (odd paisa to SGST).
    const tax = first.cgstPaise + first.sgstPaise;
    expect(Math.abs(tax - taxFromInclusive(33_333, 500))).toBeLessThanOrEqual(1);
    expect(first.sgstPaise - first.cgstPaise).toBeGreaterThanOrEqual(0);
    expect(first.sgstPaise - first.cgstPaise).toBeLessThanOrEqual(2);

    await http(c, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    const after = await invoiceOf(order.number);
    expect(after.creditNotes).toHaveLength(2);
    const credited = sumLines(
      after.creditNotes.flatMap((n) => n.lines as unknown as CreditNoteLine[]),
    );
    expect(credited).toEqual({
      taxableValuePaise: invoice.taxableValuePaise,
      cgstPaise: invoice.cgstPaise,
      sgstPaise: invoice.sgstPaise,
      igstPaise: 0,
      totalPaise: invoice.totalPaise,
    });
    // Column totals match the lines.
    for (const n of after.creditNotes) {
      expect(n.totalPaise).toBe(sumLines(n.lines as unknown as CreditNoteLine[]).totalPaise);
    }

    // Nothing left: crediting more is refused, "remaining" issues nothing.
    await expect(
      prisma.$transaction((tx) =>
        invoicing.issueCreditNote(tx, invoice.orderId, { amountPaise: 1, reason: 'Too much' }),
      ),
    ).rejects.toThrow(/exceeds/);
    expect(
      await prisma.$transaction((tx) =>
        invoicing.issueCreditNote(tx, invoice.orderId, { amountPaise: 'remaining', reason: 'x' }),
      ),
    ).toBeNull();
  });

  it('cancelling an order that was never invoiced issues no credit note', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'prepaid');
    const res = await http(c, 'post', `/v1/orders/${order.number}/cancel`).expect(200);
    expect(orderDetailSchema.parse(res.body)).toMatchObject({ invoice: null, creditNotes: [] });
  });
});

describe('numbering', () => {
  it('is sequential with no gaps under concurrency, and a rolled-back issue reuses its number', async () => {
    const c = await customer();
    const ids = await Promise.all(Array.from({ length: 8 }, () => insertConfirmedOrder(c.userId)));
    const issued = await Promise.all(ids.map((id) => invoicing.issueInvoice(id, FUTURE)));
    expect(issued.map((i) => i!.number).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `INV/99-00/${String(i + 1).padStart(6, '0')}`),
    );
    const series = await prisma.invoiceSeries.findUniqueOrThrow({
      where: { kind_financialYear: { kind: 'invoice', financialYear: FUTURE_FY } },
    });
    expect(series.nextNumber).toBe(9);

    // A credit note whose transaction rolls back doesn't burn its number.
    await expect(
      prisma.$transaction(async (tx) => {
        const note = await invoicing.issueCreditNote(tx, ids[0]!, {
          amountPaise: 'remaining',
          reason: 'Rolled back',
          now: FUTURE,
        });
        expect(note!.number).toBe('CN/99-00/000001');
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    const kept = await prisma.$transaction((tx) =>
      invoicing.issueCreditNote(tx, ids[0]!, {
        amountPaise: 'remaining',
        reason: 'Kept',
        now: FUTURE,
      }),
    );
    expect(kept!.number).toBe('CN/99-00/000001');
  });

  it('the sweep invoices confirmed orders that have none', async () => {
    const c = await customer();
    const id = await insertConfirmedOrder(c.userId);
    expect(await invoicing.issueMissingInvoices()).toBeGreaterThanOrEqual(1);
    expect(await prisma.invoice.findUnique({ where: { orderId: id } })).not.toBeNull();
  });
});

describe('issued documents are immutable', () => {
  it('blocks changes and deletes, but allows caching the PDF location', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod');
    const invoice = await invoiceOf(order.number);

    // Raw SQL so the trigger's message comes through (Prisma relabels the error code).
    await expect(
      prisma.$executeRaw`UPDATE invoices SET total_paise = total_paise + 1, taxable_value_paise = taxable_value_paise + 1 WHERE id = ${invoice.id}::uuid`,
    ).rejects.toThrow(/issued tax documents are immutable/);
    await expect(
      prisma.$executeRaw`UPDATE invoices SET buyer = '{}' WHERE id = ${invoice.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`DELETE FROM invoices WHERE id = ${invoice.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { pdfKey: `invoices/${invoice.id}.pdf` },
    });

    await expect(
      prisma.$executeRaw`UPDATE invoice_series SET next_number = 1 WHERE id = ${invoice.seriesId}::uuid`,
    ).rejects.toThrow(/can only move forward/);
    await expect(
      prisma.$executeRaw`DELETE FROM invoice_series WHERE id = ${invoice.seriesId}::uuid`,
    ).rejects.toThrow(/not allowed/);
  });

  it('rejects an IGST invoice within the seller state at the database', async () => {
    const c = await customer();
    const order = await placeOrder(c, 'cod');
    const invoice = await invoiceOf(order.number);
    const orderId = await insertConfirmedOrder(c.userId);
    await expect(
      prisma.$executeRaw`INSERT INTO invoices (id, order_id, series_id, sequence, number, seller_gstin, seller_state_code, place_of_supply_code, taxable_value_paise, igst_paise, total_paise, seller, buyer, lines)
        VALUES (${randomUUID()}::uuid, ${orderId}::uuid, ${invoice.seriesId}::uuid, 999999, 'INV/XX/BAD', '27ABCDE1234F1Z5', '27', '27', 100, 5, 105, '{}', '{}', '[{}]')`,
    ).rejects.toThrow(/invoices_gst_place_chk/);
  });
});

describe('addresses', () => {
  it('asks for English letters, which invoices and courier labels need', async () => {
    const c = await customer();
    await http(c, 'post', '/v1/cart/items').send({ variantId: f.fifteen }).expect(200);
    const res = await http(c, 'post', '/v1/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({ paymentMethod: 'cod', address: { ...PUNE, name: 'आशा राव' } })
      .expect(400);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('VALIDATION_FAILED');
  });
});
