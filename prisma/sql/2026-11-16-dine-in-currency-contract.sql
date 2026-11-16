-- ─────────────────────────────────────────────────────────────────────────────
-- Native-GHS currency contract for the dine-in and business-ledger money surfaces
-- (additive, re-runnable)
--
-- WHY THIS FILE EXISTS AND IS NOT A PRISMA MIGRATION
-- Production applies schema changes with `prisma db push`, which creates columns
-- but NOT CHECK constraints and NOT triggers. The invariant here is the whole
-- point of the change — "a cedi sale is never stored as USDC income" — so it is
-- expressed as SQL that must be applied deliberately, and the application layer
-- enforces the same rule so the invariant still holds if this file is missed.
--
-- Every statement is top-level and idempotent (DROP ... IF EXISTS then ADD, or
-- ADD COLUMN IF NOT EXISTS), so the file can be re-run safely. Tooling must strip
-- comment lines before splitting on the semicolon.
--
-- NULL-SAFE ON PURPOSE: a CHECK passes when it evaluates to NULL, so every
-- nullable comparison below is COALESCE-guarded and every branch is a real
-- boolean. See the BusinessOrder contract for the bug this avoids.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── DineInTab ────────────────────────────────────────────────────────────────
ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(8);
ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "subtotalGhs" DECIMAL(20,2);
ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "taxTotalGhs" DECIMAL(20,2);
ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "tipGhs" DECIMAL(20,2);
ALTER TABLE "DineInTab" ADD COLUMN IF NOT EXISTS "grandTotalGhs" DECIMAL(20,2);

ALTER TABLE "DineInTab" DROP CONSTRAINT IF EXISTS ck_dineintab_currency_allowed;
ALTER TABLE "DineInTab" ADD CONSTRAINT ck_dineintab_currency_allowed CHECK (
    "currency" IS NULL OR "currency" IN ('GHS', 'USDC')
);

-- A tab is exactly one of: legacy/untagged USDC (no cedi totals anywhere), or
-- native GHS (a cedi tab, whose USDC-named columns must stay empty).
--
-- Deliberately NOT "a GHS tab must already have a grand total": an OPEN tab is
-- being built up and has none until it settles. What must never happen is MIXING
-- — a GHS tab carrying USDC money, or an untagged tab carrying cedi money, since
-- either is a row no reader can classify.
ALTER TABLE "DineInTab" DROP CONSTRAINT IF EXISTS ck_dineintab_currency_shape;
ALTER TABLE "DineInTab" ADD CONSTRAINT ck_dineintab_currency_shape CHECK (
    (COALESCE("currency", '') = 'GHS'
        AND "currency" IS NOT NULL
        AND COALESCE("subtotalUsdc", 0) = 0
        AND COALESCE("taxTotalUsdc", 0) = 0
        AND COALESCE("tipUsdc", 0) = 0
        AND COALESCE("grandTotalUsdc", 0) = 0)
 OR (COALESCE("currency", '') <> 'GHS'
        AND "subtotalGhs" IS NULL AND "taxTotalGhs" IS NULL
        AND "tipGhs" IS NULL AND "grandTotalGhs" IS NULL)
);

-- ── DineInTabItem ────────────────────────────────────────────────────────────
ALTER TABLE "DineInTabItem" ADD COLUMN IF NOT EXISTS "unitPriceGhs" DECIMAL(20,2);
ALTER TABLE "DineInTabItem" ADD COLUMN IF NOT EXISTS "lineTotalGhs" DECIMAL(20,2);

-- Both cedi line values or neither: a line with a total but no unit price (or
-- the reverse) cannot be reconstructed or audited.
ALTER TABLE "DineInTabItem" DROP CONSTRAINT IF EXISTS ck_dineintabitem_ghs_complete;
ALTER TABLE "DineInTabItem" ADD CONSTRAINT ck_dineintabitem_ghs_complete CHECK (
    ("unitPriceGhs" IS NULL AND "lineTotalGhs" IS NULL)
 OR ("unitPriceGhs" IS NOT NULL AND "lineTotalGhs" IS NOT NULL)
);

-- ── BusinessLedgerEntry ──────────────────────────────────────────────────────
ALTER TABLE "BusinessLedgerEntry" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(8);
-- A native-GHS entry carries no USDC amount at all, so the column must admit NULL
-- rather than be filled with a cedi number (the defect this contract removes) or
-- with a fake 0.
ALTER TABLE "BusinessLedgerEntry" ALTER COLUMN "amount" DROP NOT NULL;

ALTER TABLE "BusinessLedgerEntry" DROP CONSTRAINT IF EXISTS ck_businessledgerentry_currency_allowed;
ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT ck_businessledgerentry_currency_allowed CHECK (
    "currency" IS NULL OR "currency" IN ('GHS', 'USDC')
);

ALTER TABLE "BusinessLedgerEntry" DROP CONSTRAINT IF EXISTS ck_businessledgerentry_currency_shape;
ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT ck_businessledgerentry_currency_shape CHECK (
    (COALESCE("currency", '') = 'GHS' AND "amount" IS NULL AND "amountGhs" IS NOT NULL)
 OR (COALESCE("currency", '') <> 'GHS' AND "amount" IS NOT NULL)
);

-- An entry must carry money in one of the two representations. A row with neither
-- silently drops out of every merchant total.
ALTER TABLE "BusinessLedgerEntry" DROP CONSTRAINT IF EXISTS ck_businessledgerentry_amount_present;
ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT ck_businessledgerentry_amount_present CHECK (
    "amount" IS NOT NULL OR "amountGhs" IS NOT NULL
);

-- ── BusinessInvoice ──────────────────────────────────────────────────────────
ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(8);
ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "subtotalGhs" DECIMAL(20,2);
ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "taxTotalGhs" DECIMAL(20,2);
ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "tipGhs" DECIMAL(20,2);
ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "billTotalGhs" DECIMAL(20,2);
ALTER TABLE "BusinessInvoice" ADD COLUMN IF NOT EXISTS "customerPaidGhs" DECIMAL(20,2);

ALTER TABLE "BusinessInvoice" DROP CONSTRAINT IF EXISTS ck_businessinvoice_currency_allowed;
ALTER TABLE "BusinessInvoice" ADD CONSTRAINT ck_businessinvoice_currency_allowed CHECK (
    "currency" IS NULL OR "currency" IN ('GHS', 'USDC')
);

-- Same rule as a dine-in tab: a bill is EITHER legacy/untagged USDC (no cedi
-- figures) OR native GHS (cedi figures, no USDC money). Mixing is unreadable.
-- A DRAFT GHS bill has a subtotal and total from creation; the cedi columns are
-- therefore required whenever the row is tagged GHS.
ALTER TABLE "BusinessInvoice" DROP CONSTRAINT IF EXISTS ck_businessinvoice_currency_shape;
ALTER TABLE "BusinessInvoice" ADD CONSTRAINT ck_businessinvoice_currency_shape CHECK (
    (COALESCE("currency", '') = 'GHS'
        AND "currency" IS NOT NULL
        AND "billTotalGhs" IS NOT NULL
        AND COALESCE("subtotalUsdc", 0) = 0
        AND COALESCE("taxTotalUsdc", 0) = 0
        AND COALESCE("tipUsdc", 0) = 0
        AND COALESCE("billTotalUsdc", 0) = 0
        AND COALESCE("feeUsdc", 0) = 0
        AND COALESCE("customerPaidUsdc", 0) = 0)
 OR (COALESCE("currency", '') <> 'GHS'
        AND "subtotalGhs" IS NULL AND "taxTotalGhs" IS NULL
        AND "tipGhs" IS NULL AND "billTotalGhs" IS NULL
        AND "customerPaidGhs" IS NULL)
);

-- ── BusinessInvoiceLineItem ──────────────────────────────────────────────────
ALTER TABLE "BusinessInvoiceLineItem" ADD COLUMN IF NOT EXISTS "unitPriceGhs" DECIMAL(20,2);
ALTER TABLE "BusinessInvoiceLineItem" ADD COLUMN IF NOT EXISTS "lineTotalGhs" DECIMAL(20,2);

ALTER TABLE "BusinessInvoiceLineItem" DROP CONSTRAINT IF EXISTS ck_invoicelineitem_ghs_complete;
ALTER TABLE "BusinessInvoiceLineItem" ADD CONSTRAINT ck_invoicelineitem_ghs_complete CHECK (
    ("unitPriceGhs" IS NULL AND "lineTotalGhs" IS NULL)
 OR ("unitPriceGhs" IS NOT NULL AND "lineTotalGhs" IS NOT NULL)
);

-- ── BusinessInvoiceTaxLine ───────────────────────────────────────────────────
ALTER TABLE "BusinessInvoiceTaxLine" ADD COLUMN IF NOT EXISTS "computedAmountGhs" DECIMAL(20,2);
