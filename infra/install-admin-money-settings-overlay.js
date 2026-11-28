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

  // A GHS setting is stored as a CANONICAL two-decimal string: "25.00" yes,
  // "25" and "25.1" no. The earlier form accepted integer and one-decimal text,
  // which is exactly the ambiguity this model exists to remove ("25" cannot be
  // distinguished from a whole-unit amount by a reader that has to re-render it).
  //
  // DROP-then-ADD rather than IF NOT EXISTS on purpose: a looser constraint
  // already installed in an environment must be REPLACED, and IF NOT EXISTS
  // would silently keep it. The ADD fails closed if any existing row violates
  // the stricter shape, which is the correct outcome.
  `ALTER TABLE "AdminMoneySettingRevision"
     DROP CONSTRAINT IF EXISTS admin_money_setting_ghs_canonical_check;`,
  `ALTER TABLE "AdminMoneySettingRevision"
     ADD CONSTRAINT admin_money_setting_ghs_canonical_check
     CHECK ("kind" <> 'ghs' OR "valueText" ~ '^[0-9]+\\.[0-9]{2}$');`,

  // Append-only: revisions are history. Refusing UPDATE alone does not make a
  // log append-only — an UPDATE-only guard still permits DELETE and TRUNCATE, so
  // the history disappears one row or one statement at a time. All three are
  // refused here, at the database, for every identity that is not able to drop
  // the trigger itself.
  //
  // ENFORCED BOUNDARY, stated exactly rather than implied:
  //   • EVERY identity that is not the table owner is refused UPDATE, DELETE and
  //     TRUNCATE — that is the runtime/service identity, which is who could
  //     actually destroy history in production. Proved with a restricted LOGIN
  //     role that holds DELETE and TRUNCATE privileges and is still refused.
  //   • The table OWNER (and a superuser) retains administrative capability, and
  //     can also drop the trigger or set `session_replication_role = replica`.
  //     Allowing the owner is deliberate: it is what lets intended maintenance
  //     and test teardown clear the table, and pretending otherwise would be a
  //     claim this mechanism cannot make. A fully owner-proof log needs the owner
  //     and the writer to be different PostgreSQL identities, which is a
  //     deployment decision rather than something an overlay can grant itself.
  `CREATE OR REPLACE FUNCTION admin_money_setting_revision_append_only()
     RETURNS trigger AS $fn$
   DECLARE
     is_owner boolean;
   BEGIN
     SELECT (current_user = tableowner) INTO is_owner
       FROM pg_tables WHERE schemaname = 'public' AND tablename = 'AdminMoneySettingRevision';
     IF is_owner THEN
       IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
       RETURN NULL; -- UPDATE and TRUNCATE: allow the owner's own statement through
     END IF;
     RAISE EXCEPTION 'AdminMoneySettingRevision is append-only: % is refused for % (write a new revision)', TG_OP, current_user
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

  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgname = 'admin_money_setting_revision_no_delete'
     ) THEN
       CREATE TRIGGER admin_money_setting_revision_no_delete
         BEFORE DELETE ON "AdminMoneySettingRevision"
         FOR EACH ROW EXECUTE FUNCTION admin_money_setting_revision_append_only();
     END IF;
   END $$;`,

  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger WHERE tgname = 'admin_money_setting_revision_no_truncate'
     ) THEN
       CREATE TRIGGER admin_money_setting_revision_no_truncate
         BEFORE TRUNCATE ON "AdminMoneySettingRevision"
         FOR EACH STATEMENT EXECUTE FUNCTION admin_money_setting_revision_append_only();
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
