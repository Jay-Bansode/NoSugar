-- Wallet credit is a payment (tender), not a discount, so the GST in an order can exceed the
-- amount still payable after wallet. The correct bound is the amount charged before wallet:
--   tax ≤ subtotal − discount + shipping + cod_fee  (= total + wallet)
ALTER TABLE "orders" DROP CONSTRAINT "orders_tax_lte_total_chk";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tax_lte_charged_chk" CHECK ("tax_paise" <= "total_paise" + "wallet_paise");
