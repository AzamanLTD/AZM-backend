-- ─────────────────────────────────────────────────────────────────────────────
-- BusinessOrder currency contract (additive, re-runnable)
--
-- WHY THIS FILE EXISTS AND IS NOT A PRISMA MIGRATION
-- Production applies schema changes with `prisma db push`, which creates columns
-- but does NOT create CHECK constraints. The currency invariant is the whole
-- point of this change, so it is expressed here as SQL that must be applied
-- deliberately, and the application layer enforces the same rule so the invariant
-- still holds if this file is ever missed.
--
-- Each statement is top-level and idempotent (DROP ... IF EXISTS then ADD), so the
-- file can be re-run safely. Tooling should strip comment lines before splitting on the
-- statement delimiter, since comments may contain that character.
--
-- WHAT IT DOES NOT DO
--  * No positivity CHECK. A legacy zero-amount order may legitimately exist (free
--    items, comps) and production data cannot be inspected from here; adding
--    `amount > 0` could make a real deployment fail its migration for a reason
--    unrelated to currency. Positivity is enforced at the service boundary instead.
--  * No backfill. Legacy rows keep currency NULL and their historical USDC meaning.
-- ─────────────────────────────────────────────────────────────────────────────

-- 8, not 3: the platform's asset is "USDC" (four characters), not ISO "USD".
ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(8);
ALTER TABLE "BusinessOrder" ALTER COLUMN "currency" TYPE VARCHAR(8);
ALTER TABLE "BusinessOrder" ADD COLUMN IF NOT EXISTS "amountGhs" DECIMAL(20,2);
ALTER TABLE "BusinessOrder" ALTER COLUMN "amountUsdc" DROP NOT NULL;

-- A row is either legacy/untagged with a USDC amount, an explicit USDC order, or a
-- native GHS order with no USDC amount. It can never be both, and a GHS-tagged row
-- must carry the GHS amount.
ALTER TABLE "BusinessOrder" DROP CONSTRAINT IF EXISTS ck_businessorder_currency_shape;
ALTER TABLE "BusinessOrder" ADD CONSTRAINT ck_businessorder_currency_shape CHECK (
    ("amountUsdc" IS NOT NULL AND "amountGhs" IS NULL AND ("currency" IS NULL OR "currency" = 'USDC'))
 OR ("amountUsdc" IS NULL     AND "amountGhs" IS NOT NULL AND "currency" = 'GHS')
);

-- Only the two currencies the platform can actually settle.
ALTER TABLE "BusinessOrder" DROP CONSTRAINT IF EXISTS ck_businessorder_currency_allowed;
ALTER TABLE "BusinessOrder" ADD CONSTRAINT ck_businessorder_currency_allowed CHECK (
    "currency" IS NULL OR "currency" IN ('GHS', 'USDC')
);

-- An order must carry money in one of the two representations; a row with neither
-- is not an order and would silently drop out of every revenue total.
ALTER TABLE "BusinessOrder" DROP CONSTRAINT IF EXISTS ck_businessorder_amount_present;
ALTER TABLE "BusinessOrder" ADD CONSTRAINT ck_businessorder_amount_present CHECK (
    "amountUsdc" IS NOT NULL OR "amountGhs" IS NOT NULL
);

-- ── A LIMIT THIS FILE CANNOT ENFORCE, RECORDED SO NOBODY ASSUMES IT DOES ─────
-- Postgres COERCES to the column's scale before any CHECK runs: '25.005' inserted
-- into DECIMAL(20,2) arrives at the constraint already rounded to 25.01. A
-- "amountGhs = round(amountGhs, 2)" CHECK therefore always passes and would only
-- create false confidence, so it is deliberately absent.
-- Refusing sub-pesewa input is a SERVICE responsibility: validate the incoming
-- decimal STRING has at most 2 fractional digits before it reaches Postgres.
