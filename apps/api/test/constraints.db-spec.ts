/**
 * Proves the database itself enforces the CLAUDE.md §8 integrity rules, independent of app
 * code. Needs a migrated Postgres (DATABASE_URL). Run: pnpm --filter @brand/api test:db
 *
 * Everything runs inside one transaction that is rolled back at the end, so nothing persists.
 * Each expected failure runs inside a SAVEPOINT so the transaction stays usable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PG = {
  checkViolation: '23514',
  uniqueViolation: '23505',
  restrictViolation: '23001',
} as const;

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for db tests');

const client = new pg.Client({ connectionString: url });
let savepoint = 0;

async function q(sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  return client.query(sql, params);
}

/** Runs `sql` and asserts it fails with the given Postgres error code (and constraint name). */
async function expectPgError(
  sql: string,
  params: unknown[],
  code: string,
  constraint?: string,
): Promise<void> {
  const name = `sp_${++savepoint}`;
  await q(`SAVEPOINT ${name}`);
  try {
    await q(sql, params);
    expect.unreachable(`expected error ${code}${constraint ? ` (${constraint})` : ''}`);
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    expect(pgErr.code).toBe(code);
    if (constraint) expect(pgErr.constraint).toBe(constraint);
  } finally {
    await q(`ROLLBACK TO SAVEPOINT ${name}`);
  }
}

async function insertUser(phone = `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`) {
  const id = randomUUID();
  await q(`INSERT INTO users (id, phone, updated_at) VALUES ($1, $2, now())`, [id, phone]);
  return { id, phone };
}

async function insertProduct() {
  const id = randomUUID();
  await q(
    `INSERT INTO products (id, slug, name, type, updated_at) VALUES ($1, $2, 'Test', 'coffee', now())`,
    [id, `test-${id}`],
  );
  return id;
}

const variantSql = `INSERT INTO variants
  (id, product_id, sku, name, mrp_paise, price_paise, hsn_code, gst_rate_bps, stock, reserved_stock, weight_g, updated_at)
  VALUES ($1, $2, $3, 'v', $4, $5, '2101', $6, $7, $8, 100, now())`;

const orderSql = `INSERT INTO orders
  (id, number, customer_id, status, payment_method, subtotal_paise, discount_paise, wallet_paise,
   shipping_paise, cod_fee_paise, tax_paise, total_paise, shipping_address, idempotency_key, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11, '{}', $12, now())`;

/** A valid prepaid order: ₹299 + ₹99 shipping = ₹398. */
function orderParams(customerId: string, overrides: Partial<Record<string, unknown>> = {}) {
  const o = {
    id: randomUUID(),
    number: `T-${randomUUID().slice(0, 8)}`,
    status: 'pending_payment',
    method: 'prepaid',
    subtotal: 29900,
    discount: 0,
    shipping: 9900,
    codFee: 0,
    tax: 1424,
    total: 39800,
    key: randomUUID(),
    ...overrides,
  };
  return [
    o.id,
    o.number,
    customerId,
    o.status,
    o.method,
    o.subtotal,
    o.discount,
    o.shipping,
    o.codFee,
    o.tax,
    o.total,
    o.key,
  ];
}

beforeAll(async () => {
  await client.connect();
  await q('BEGIN');
});

afterAll(async () => {
  await q('ROLLBACK');
  await client.end();
});

describe('users', () => {
  it('phone is unique', async () => {
    const { phone } = await insertUser();
    await expectPgError(
      `INSERT INTO users (id, phone, updated_at) VALUES ($1, $2, now())`,
      [randomUUID(), phone],
      PG.uniqueViolation,
    );
  });

  it('phone must be E.164', async () => {
    await expectPgError(
      `INSERT INTO users (id, phone, updated_at) VALUES ($1, '9876543210', now())`,
      [randomUUID()],
      PG.checkViolation,
      'users_phone_e164_chk',
    );
  });
});

describe('variants', () => {
  it('accepts a valid variant', async () => {
    const productId = await insertProduct();
    await q(variantSql, [randomUUID(), productId, `SKU-${randomUUID()}`, 34900, 29900, 500, 10, 2]);
  });

  it.each([
    ['negative price', 34900, -1, 500, 10, 0, 'variants_money_nonneg_chk'],
    ['price above MRP', 29900, 34900, 500, 10, 0, 'variants_price_lte_mrp_chk'],
    ['GST above 100%', 34900, 29900, 10_001, 10, 0, 'variants_gst_rate_chk'],
    ['negative stock', 34900, 29900, 500, -1, 0, 'variants_stock_chk'],
    ['reserved above stock', 34900, 29900, 500, 5, 6, 'variants_stock_chk'],
  ])('rejects %s', async (_label, mrp, price, gst, stock, reserved, constraint) => {
    const productId = await insertProduct();
    await expectPgError(
      variantSql,
      [randomUUID(), productId, `SKU-${randomUUID()}`, mrp, price, gst, stock, reserved],
      PG.checkViolation,
      constraint,
    );
  });
});

describe('cart_items', () => {
  it('must target exactly one of variant or bundle', async () => {
    const cartId = randomUUID();
    await q(`INSERT INTO carts (id, updated_at) VALUES ($1, now())`, [cartId]);
    await expectPgError(
      `INSERT INTO cart_items (id, cart_id, quantity, updated_at) VALUES ($1, $2, 1, now())`,
      [randomUUID(), cartId],
      PG.checkViolation,
      'cart_items_target_chk',
    );
  });
});

describe('orders', () => {
  it('accepts an order whose totals add up', async () => {
    const { id } = await insertUser();
    await q(orderSql, orderParams(id));
  });

  it('rejects totals that do not add up', async () => {
    const { id } = await insertUser();
    await expectPgError(
      orderSql,
      orderParams(id, { total: 39900 }),
      PG.checkViolation,
      'orders_total_chk',
    );
  });

  it('rejects a COD fee on a prepaid order', async () => {
    const { id } = await insertUser();
    await expectPgError(
      orderSql,
      orderParams(id, { codFee: 4900, total: 44700 }),
      PG.checkViolation,
      'orders_cod_fee_chk',
    );
  });

  it('allows GST above the payable total when wallet credit paid part of it', async () => {
    // ₹699 15-pack, ₹600 wallet → ₹99 payable but ₹33.29 GST inside the ₹699 sale.
    const { id } = await insertUser();
    const sql = `INSERT INTO orders
      (id, number, customer_id, status, payment_method, subtotal_paise, discount_paise, wallet_paise,
       shipping_paise, cod_fee_paise, tax_paise, total_paise, shipping_address, idempotency_key, updated_at)
      VALUES ($1, $2, $3, 'pending_payment', 'prepaid', 69900, 0, $4, 0, 0, $5, $6, '{}', $7, now())`;
    const params = (wallet: number, taxPaise: number, total: number) => [
      randomUUID(),
      `T-${randomUUID().slice(0, 8)}`,
      id,
      wallet,
      taxPaise,
      total,
      randomUUID(),
    ];
    await q(sql, params(60000, 3329, 9900));
    // But never more GST than the amount charged before wallet.
    await expectPgError(
      sql,
      params(60000, 70000, 9900),
      PG.checkViolation,
      'orders_tax_lte_charged_chk',
    );
  });

  it('idempotency key is unique per customer', async () => {
    const { id } = await insertUser();
    const key = randomUUID();
    await q(orderSql, orderParams(id, { key }));
    await expectPgError(orderSql, orderParams(id, { key }), PG.uniqueViolation);
    // A different customer may reuse the same key.
    const other = await insertUser();
    await q(orderSql, orderParams(other.id, { key }));
  });
});

describe('order_events (append-only)', () => {
  it('blocks UPDATE and DELETE', async () => {
    const { id: customerId } = await insertUser();
    const params = orderParams(customerId);
    await q(orderSql, params);
    const { rows } = await q(
      `INSERT INTO order_events (order_id, to_status, actor) VALUES ($1, 'pending_payment', 'system') RETURNING id`,
      [params[0]],
    );
    const eventId = rows[0].id;
    await expectPgError(
      `UPDATE order_events SET note = 'edited' WHERE id = $1`,
      [eventId],
      PG.restrictViolation,
    );
    await expectPgError(`DELETE FROM order_events WHERE id = $1`, [eventId], PG.restrictViolation);
  });
});

describe('webhook_events', () => {
  it('stores each external event once per source', async () => {
    const sql = `INSERT INTO webhook_events (id, source, external_event_id, event_type, payload)
                 VALUES ($1, 'razorpay', $2, 'payment.captured', '{}')`;
    const externalId = `evt_${randomUUID()}`;
    await q(sql, [randomUUID(), externalId]);
    await expectPgError(sql, [randomUUID(), externalId], PG.uniqueViolation);
  });
});

describe('invoices', () => {
  it('rejects mixing CGST/SGST with IGST', async () => {
    const { id: customerId } = await insertUser();
    const params = orderParams(customerId);
    await q(orderSql, params);
    const seriesId = randomUUID();
    await q(
      `INSERT INTO invoice_series (id, kind, financial_year, prefix) VALUES ($1, 'invoice', '2099-00', 'T')`,
      [seriesId],
    );
    await expectPgError(
      `INSERT INTO invoices (id, order_id, series_id, sequence, number, seller_gstin, seller_state_code,
         place_of_supply_code, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
       VALUES ($1, $2, $3, 1, $4, 'GSTIN', '27', '29', 10000, 250, 250, 500, 11000)`,
      [randomUUID(), params[0], seriesId, `T/${randomUUID()}`],
      PG.checkViolation,
      'invoices_gst_kind_chk',
    );
  });
});

describe('discounts', () => {
  it('codes must be upper-case', async () => {
    await expectPgError(
      `INSERT INTO discounts (id, code, type, value_bps, updated_at) VALUES ($1, 'welcome10', 'percentage', 1000, now())`,
      [randomUUID()],
      PG.checkViolation,
      'discounts_code_upper_chk',
    );
  });
});
