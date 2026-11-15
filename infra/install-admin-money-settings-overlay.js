#!/usr/bin/env node
// Idempotent additive installer for the append-only money-settings revision log.
//
// WHY THIS EXISTS: src/services/moneySettingsService.js and the Admin Money
// Settings API (#404) depend on the "AdminMoneySettingRevision" table, but a
// Prisma model plus a local `prisma db push` is NOT a production release path
// in this repository. Per DEPLOY_RUNBOOK.md the only production DDL path is the
// overlay installers run by `npm run release`; `prisma db push` serves
// disposable dev/test databases and does not create CHECK constraints. Without
// this installer the model would exist in the schema and be missing in
// production, which is the exact failure mode this chain is meant to prevent.
//
// DDL shape below is the exact render `prisma db push` produces for
// prisma/schema.prisma, so the db-push path (dev/CI) and the release-chain path
// (production) converge on identical structure. `id` carries NO database
// default because @default(uuid()) is client-side in Prisma.
//
// Invariants enforced HERE, at the database layer, because the application is
// never the authority for its own money log:
//   1. value carrier — exactly one of valueInt/valueText/valueEnum is non-null
//      per row (services/moneySettingsService.js writes exactly one), so a row
//      can never be read as two kinds at once.
//   2. canonical GHS — when kind = 'ghs', valueText must already be a canonical
//      2dp decimal string. A GHS setting can never be stored as a float
//      rendering or with sub-pesewa precision.
//   3. append-only for UPDATE — a revision is history. Corrections are new
//      rows; an in-place rewrite of a money revision is refused by the database.
//
// Idempotent: every statement is a no-op on re-run. Mirrors
// install-business-price-overlay.js (PrismaClient + raw statements, fail-closed
// exit code). CI runs this after `db push`; the release chain runs it standalone.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "AdminMoneySettingRevision" (
     "id" TEXT NOT NULL,
     "key" TEXT NOT NULL,
     "kind" TEXT NOT NULL,
     "valueInt" INTEGER,
     "valueText" TEXT,
     "valueEnum" TEXT,
     "effectiveAt" TIMESTAMP(3) NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "adminId" INTEGER NOT NULL,
     "adminName" TEXT,
     "reason" TEXT NOT NULL,
     CONSTRAINT "AdminMoneySettingRevision_pkey" PRIMARY KEY ("id")
   );`,

  `CREATE INDEX IF NOT EXISTS "AdminMoneySettingRevision_key_effectiveAt_createdAt_idx"
     ON "AdminMoneySettingRevision" ("key", "effectiveAt" DESC, "createdAt" DESC);`,

  `CREATE INDEX IF NOT EXISTS "AdminMoneySettingRevision_createdAt_idx"
     ON "AdminMoneySettingRevision" ("createdAt" DESC);`,

  // Exactly one value carrier, so a row cannot be two kinds at once.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'admin_money_setting_value_carrier_check'
     ) THEN
       ALTER TABLE "AdminMoneySettingRevision"
         ADD CONSTRAINT "admin_money_setting_value_carrier_check"
         CHECK (num_nonnulls("valueInt", "valueText", "valueEnum") = 1);
     END IF;
   END $$;`,

  // A GHS setting is stored as a canonical 2dp decimal string, never a float
  // rendering and never sub-pesewa.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'admin_money_setting_ghs_canonical_check'
     ) THEN
       ALTER TABLE "AdminMoneySettingRevision"
         ADD CONSTRAINT "admin_money_setting_ghs_canonical_check"
         CHECK ("kind" <> 'ghs' OR "valueText" ~ '^[0-9]+(\\.[0-9]{1,2})?$');
     END IF;
   END $$;`,

  // Append-only: revisions are history. Refuse in-place rewrites at the
  // database, not merely by convention in the service.
  `CREATE OR REPLACE FUNCTION admin_money_setting_revision_append_only()
     RETURNS trigger AS $fn$
   BEGIN
     RAISE EXCEPTION 'AdminMoneySettingRevision is append-only: write a new revision instead of updating %', OLD.id
       USING ERRCODE = 'check_violation';
   END;
   $fn$ LANGUAGE plpgsql;`,

  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgname = 'admin_money_setting_revision_no_update'
     ) THEN
       CREATE TRIGGER admin_money_setting_revision_no_update
         BEFORE UPDATE ON "AdminMoneySettingRevision"
         FOR EACH ROW EXECUTE FUNCTION admin_money_setting_revision_append_only();
     END IF;
   END $$;`,
];

async function main() {
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.error(`[admin-money-settings-overlay] statement failed: ${error.message}`);
      throw error;
    }
  }
  logger.info('[admin-money-settings-overlay] AdminMoneySettingRevision table + constraints installed (idempotent)');
}

main()
  .catch((error) => {
    logger.error(`[admin-money-settings-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
