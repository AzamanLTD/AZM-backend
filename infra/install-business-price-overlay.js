#!/usr/bin/env node
// Idempotent additive installer for the GHS listing-price DB constraints.
// Authority: docs/MARKETPLACE_GHS_PRICING_AND_PAYMENT_CONTRACT_2026-10-10.md §1.1
// (Option B, owner-approved 2026-10-10) and the finalized Mix decisions.
//
// The BusinessPrice TABLE itself is Prisma-managed (db push). Two constraints
// cannot be expressed in prisma/schema.prisma and are enforced HERE, at the
// database layer, so the application service is never the authority:
//   1. business_price_current_unique — a PARTIAL unique index guaranteeing at
//      most one ACTIVE, current (effective_to IS NULL) row per price identity
//      (business_product_id, currency, scope, COALESCE(location_id, '')).
//   2. business_price_effective_window_check — effective dating integrity:
//      effective_to IS NULL OR effective_to > effective_from.
//   2b. business_price_scope_location_check — scope/location integrity:
//      DEFAULT requires location_id IS NULL (the global identity); BRANCH
//      requires a non-null location id. A malformed combination can never
//      be written by ANY path, raw writes included.
//   3. business_price_amount_positive — a base price is positive; zero is
//      permitted only under a separately approved free-item model (none in v1).
//   4. business_price_scope_check / business_price_status_check /
//      business_price_confirmed_by_check / business_price_currency_check —
//      closed value domains for the scoped price row.
//
// Prisma db push does not know these objects; they are created idempotently
// here and re-asserted on every install, mirroring the established overlay
// pattern (install-transaction-quote-overlay.js). CI runs this installer
// before the test suite; production runs it via the release chain.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  // One ACTIVE current row per price identity — the DB, not the service,
  // is the single-current-price authority. COALESCE folds the NULL
  // locationId of DEFAULT scope into the identity.
  `CREATE UNIQUE INDEX IF NOT EXISTS "business_price_current_unique"
     ON "BusinessPrice" ("businessProductId", "currency", "scope", COALESCE("locationId", ''))
     WHERE "status" = 'ACTIVE' AND "effectiveTo" IS NULL;`,

  // Effective-date integrity: a closed window is strictly ordered, and
  // archiving closes exactly one active window.
  // Added NOT VALID (no full-table scan on live installs), then VALIDATEd so
  // the constraint is fully enforced for existing rows too (PHASE_J2 pattern).
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_effective_window_check'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_effective_window_check"
         CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom") NOT VALID;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_effective_window_check' AND NOT convalidated
     ) THEN
       ALTER TABLE "BusinessPrice" VALIDATE CONSTRAINT "business_price_effective_window_check";
     END IF;
   END $$;`,

  // A base listing price is positive. Zero is allowed only under a
  // separately approved free-item model — none exists in v1.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_amount_positive'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_amount_positive"
         CHECK ("amountExact" > 0);
     END IF;
   END $$;`,

  // Closed value domains (aligned with the service enum tables).
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_scope_check'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_scope_check"
         CHECK ("scope" IN ('DEFAULT', 'BRANCH'));
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_status_check'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_status_check"
         CHECK ("status" IN ('ACTIVE', 'ARCHIVED'));
     END IF;
   END $$;`,

  // Scope/location integrity: the DEFAULT (global) identity is the row with a
  // NULL location; BRANCH rows must name one. Raw writes violating the
  // combination are rejected by the database, not by app code.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_scope_location_check'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_scope_location_check"
         CHECK (
           ("scope" = 'DEFAULT' AND "locationId" IS NULL)
           OR ("scope" = 'BRANCH' AND "locationId" IS NOT NULL)
         ) NOT VALID;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_scope_location_check' AND NOT convalidated
     ) THEN
       ALTER TABLE "BusinessPrice" VALIDATE CONSTRAINT "business_price_scope_location_check";
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_confirmed_by_check'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_confirmed_by_check"
         CHECK ("confirmedByType" IN ('BUSINESS', 'ADMIN', 'MIGRATION'));
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'business_price_currency_check'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "business_price_currency_check"
         CHECK ("currency" IN ('GHS'));
     END IF;
   END $$;`,
];

async function main() {
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.error(`[business-price-overlay] statement failed: ${error.message}`);
      throw error;
    }
  }
  logger.info('[business-price-overlay] BusinessPrice DB constraints installed (idempotent)');
}

main()
  .catch((error) => {
    logger.error(`[business-price-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
