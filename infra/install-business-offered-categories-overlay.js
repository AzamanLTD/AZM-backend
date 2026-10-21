#!/usr/bin/env node
// Idempotent additive installer for the BusinessProfile.offeredCategories
// column (Workstream D, PR #366 — declared additional offerings).
//
// PROVISIONING CONTRACT (DEPLOY_RUNBOOK.md): production DDL is deployed
// EXCLUSIVELY by these overlay installers via `npm run release`; `prisma
// db push` and `prisma migrate deploy` are NOT production paths. The
// "offeredCategories" COLUMN is therefore added HERE — the DDL below is
// the exact shape `prisma db push` renders from prisma/schema.prisma
// (BusinessCategory[] enum array, NOT NULL, empty-array default), so the
// db-push path (disposable dev/test + CI) and the release-chain path
// (production) converge on identical structure.
//
// Semantics (prisma/schema.prisma comment, 2026-10-21): the list carries
// only explicitly declared ADDITIONAL offerings; the primary category
// stays in the separate `category` column. Backward compatible: existing
// rows keep the empty array, which is a valid state. Closed value domain
// comes from the pre-existing "BusinessCategory" enum itself — no new
// CHECK constraints are needed; the enum array cannot hold any non-enum
// value on ANY write path, raw writes included.
//
// Idempotent: safe to re-run on every deploy. FAIL-CLOSED on drift: if the
// column already exists with a different shape the installer aborts with
// a non-zero exit instead of silently leaving a mismatched column.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  // Exact prisma/schema.prisma render (db push shape) for the new column.
  `ALTER TABLE "BusinessProfile"
     ADD COLUMN IF NOT EXISTS "offeredCategories"
     "BusinessCategory"[] NOT NULL DEFAULT ARRAY[]::"BusinessCategory"[]`,
  // Drift guard: the column must now exist with the exact expected shape.
  // (type, nullability, and array-ness come from information_schema +
  // pg_catalog; anything else is deployment drift we refuse to mask.)
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
       JOIN pg_catalog.pg_type t ON t.oid = c.udt_name::regtype::oid
       WHERE c.table_name = 'BusinessProfile'
         AND c.column_name = 'offeredCategories'
         AND c.is_nullable = 'NO'
         AND t.typname = 'businesscategory'
     ) THEN
       RAISE EXCEPTION
         'BusinessProfile.offeredCategories drift: expected NOT NULL '
         '"BusinessCategory"[] (enum array) after overlay; refusing to '
         'mask a mismatched column shape';
     END IF;
   END $$;`,
];

async function main() {
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.error(
          `[business-offered-categories-overlay] statement failed: ${error.message}`);
      throw error;
    }
  }
  logger.info(
      '[business-offered-categories-overlay] BusinessProfile.offeredCategories '
      + 'column installed (idempotent, drift-guarded)');
}

main()
  .catch((error) => {
    logger.error(
        `[business-offered-categories-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
