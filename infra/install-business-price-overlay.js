#!/usr/bin/env node
// Idempotent additive installer for the GHS listing-price table + DB constraints.
// Authority: docs/MARKETPLACE_GHS_PRICING_AND_PAYMENT_CONTRACT_2026-10-10.md §1.1
// (Option B, owner-approved 2026-10-10) and the finalized Mix decisions.
//
// PROVISIONING CONTRACT (DEPLOY_RUNBOOK.md): production DDL is deployed
// EXCLUSIVELY by these overlay installers via `npm run release`; `prisma
// db push` and `prisma migrate deploy` are NOT production paths. The
// "BusinessPrice" TABLE is therefore created HERE — the DDL below is the
// exact shape `prisma db push` renders from prisma/schema.prisma, so the
// db-push path (disposable dev/test + CI) and the release-chain path
// (production) converge on identical structure.
//
// The constraints below cannot be expressed in prisma/schema.prisma and are
// enforced HERE, at the database layer, so the application service is never
// the authority:
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
// Idempotent: safe to re-run on every deploy. Mirrors install-payment-requests
// -overlay.js (PrismaClient + raw statements, fail-closed exit code). CI runs
// this installer after `db push` (CREATE TABLE IF NOT EXISTS no-ops); the
// production release chain runs it standalone and provisions the table.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  // Exact prisma/schema.prisma render (db push shape): column names, types,
  // NOT NULLs, and Prisma-managed defaults. Note `id` has NO database default
  // — @default(uuid()) is client-side in Prisma, and the db-push shape keeps
  // the column bare; keep the two provisioning paths byte-identical.
  `CREATE TABLE IF NOT EXISTS "BusinessPrice" (
    "id"                TEXT NOT NULL,
    "businessProductId" TEXT NOT NULL,
    "currency"          VARCHAR(3) NOT NULL,
    "amountExact"       DECIMAL(20,2) NOT NULL,
    "scope"             TEXT NOT NULL DEFAULT 'DEFAULT',
    "locationId"        TEXT,
    "status"            TEXT NOT NULL DEFAULT 'ACTIVE',
    "confirmedByType"  TEXT NOT NULL DEFAULT 'BUSINESS',
    "confirmedById"     TEXT,
    "confirmedAt"       TIMESTAMP(3),
    "note"              TEXT,
    "effectiveFrom"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"       TIMESTAMP(3),
    CONSTRAINT "BusinessPrice_pkey" PRIMARY KEY ("id")
  );`,

  // FKs are added idempotently via DO blocks: a plain ADD CONSTRAINT would
  // fail the whole installer on re-run once the constraint already exists.
  // Cascade behavior mirrors the db-push render (ON UPDATE CASCADE ON DELETE
  // CASCADE): a product's prices cannot outlive the product.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'BusinessPrice_businessProductId_fkey'
     ) THEN
       ALTER TABLE "BusinessPrice"
         ADD CONSTRAINT "BusinessPrice_businessProductId_fkey"
         FOREIGN KEY ("businessProductId") REFERENCES "BusinessProduct"("id")
         ON UPDATE CASCADE ON DELETE CASCADE;
     END IF;
   END $$;`,

  // Prisma-declared @@index([businessProductId, currency, status, effectiveTo])
  // — the discovery/current-price lookup path.
  `CREATE INDEX IF NOT EXISTS "BusinessPrice_businessProductId_currency_status_effectiveTo_idx"
     ON "BusinessPrice"("businessProductId", "currency", "status", "effectiveTo");`,

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
  logger.info('[business-price-overlay] BusinessPrice table + DB constraints installed (idempotent)');
}

main()
  .catch((error) => {
    logger.error(`[business-price-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
