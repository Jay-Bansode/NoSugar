-- Slice 9: GST invoices and credit notes. No invoices existed before this migration.

-- Snapshots, so a document can be re-rendered exactly as issued.
ALTER TABLE "invoices"
  ADD COLUMN "seller" JSONB NOT NULL,
  ADD COLUMN "buyer" JSONB NOT NULL,
  ADD COLUMN "lines" JSONB NOT NULL;

ALTER TABLE "credit_notes"
  ADD COLUMN "reason" TEXT NOT NULL,
  ADD COLUMN "lines" JSONB NOT NULL;

-- GST rules: numbers up to 16 characters of letters, digits, "/" and "-".
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_number_format_chk" CHECK ("number" ~ '^[A-Za-z0-9/-]{1,16}$'),
  ADD CONSTRAINT "invoices_state_codes_chk" CHECK (
    "seller_state_code" ~ '^[0-9]{2}$' AND "place_of_supply_code" ~ '^[0-9]{2}$'
  ),
  -- CGST + SGST only within the seller's state, IGST only to other states.
  ADD CONSTRAINT "invoices_gst_place_chk" CHECK (
    CASE WHEN "seller_state_code" = "place_of_supply_code" THEN "igst_paise" = 0
         ELSE "cgst_paise" = 0 AND "sgst_paise" = 0 END
  ),
  ADD CONSTRAINT "invoices_lines_chk" CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") > 0);

ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_number_format_chk" CHECK ("number" ~ '^[A-Za-z0-9/-]{1,16}$'),
  ADD CONSTRAINT "credit_notes_total_chk" CHECK ("total_paise" > 0),
  ADD CONSTRAINT "credit_notes_reason_chk" CHECK (length("reason") BETWEEN 1 AND 500),
  ADD CONSTRAINT "credit_notes_lines_chk" CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") > 0);

-- Issued tax documents never change and are never deleted. Only the cached PDF location
-- (pdf_key) may be filled in later.
CREATE FUNCTION "forbid_tax_document_changes"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(NEW) - 'pdf_key') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'pdf_key') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: issued tax documents are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "invoices_immutable"
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION "forbid_tax_document_changes"();

CREATE TRIGGER "credit_notes_immutable"
  BEFORE UPDATE OR DELETE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION "forbid_tax_document_changes"();

CREATE TRIGGER "invoices_no_truncate"
  BEFORE TRUNCATE ON "invoices"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_update_delete"();

CREATE TRIGGER "credit_notes_no_truncate"
  BEFORE TRUNCATE ON "credit_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_update_delete"();

-- Series counters may only move forward (a lower next_number would reuse numbers).
CREATE FUNCTION "invoice_series_forward_only"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."next_number" < OLD."next_number" OR NEW."kind" <> OLD."kind"
     OR NEW."financial_year" <> OLD."financial_year" OR NEW."prefix" <> OLD."prefix" THEN
    RAISE EXCEPTION 'invoice_series can only move forward' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "invoice_series_forward_only"
  BEFORE UPDATE ON "invoice_series"
  FOR EACH ROW EXECUTE FUNCTION "invoice_series_forward_only"();

CREATE TRIGGER "invoice_series_no_delete"
  BEFORE DELETE OR TRUNCATE ON "invoice_series"
  FOR EACH STATEMENT EXECUTE FUNCTION "forbid_update_delete"();
