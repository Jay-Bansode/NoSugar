-- AlterTable
ALTER TABLE "carts" ADD COLUMN     "discount_code" TEXT;

-- Matches the API limit (updateCartSchema).
ALTER TABLE "carts" ADD CONSTRAINT "carts_discount_code_len_chk" CHECK ("discount_code" IS NULL OR char_length("discount_code") BETWEEN 1 AND 40);
