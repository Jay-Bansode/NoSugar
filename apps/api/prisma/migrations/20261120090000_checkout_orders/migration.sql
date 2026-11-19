-- Per-line share of the order discount, needed for per-line taxable value on invoices.
ALTER TABLE "order_items" ADD COLUMN "discount_paise" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "order_items" DROP CONSTRAINT "order_items_money_chk";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_money_chk" CHECK (
    "unit_price_paise" >= 0 AND "discount_paise" >= 0 AND "tax_paise" >= 0 AND
    "line_total_paise" = "unit_price_paise" * "quantity" AND
    "discount_paise" <= "line_total_paise" AND
    "tax_paise" <= "line_total_paise" - "discount_paise"
  );

-- Human-readable order numbers ("BR" + this sequence). Gaps are fine for order numbers
-- (unlike invoice numbers, which use invoice_series).
CREATE SEQUENCE "order_number_seq" START WITH 1000001 INCREMENT BY 1 NO CYCLE;
