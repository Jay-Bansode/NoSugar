-- Phase 2 slice 3: admin refunds (manual COD refunds, idempotent requests).

-- CreateEnum
CREATE TYPE "refund_method" AS ENUM ('razorpay', 'manual');

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "method" "refund_method" NOT NULL DEFAULT 'razorpay',
ADD COLUMN     "reference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "refunds_order_id_idempotency_key_key" ON "refunds"("order_id", "idempotency_key");

-- A Razorpay refund needs the payment it reverses; a manual one needs its bank/UPI reference.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_method_chk" CHECK (
    ("method" = 'razorpay' AND "payment_id" IS NOT NULL) OR
    ("method" = 'manual' AND "reference" IS NOT NULL AND length(trim("reference")) >= 4)
  ),
  -- Manual refunds are recorded once the money has been sent.
  ADD CONSTRAINT "refunds_manual_processed_chk" CHECK ("method" <> 'manual' OR "status" = 'processed');
