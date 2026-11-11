'use strict';

// infra/install-ghs-wallet-overlay.js — FX-balance workstream installer.
//
// Idempotent structural overlay for the native-GHS wallet + FX saved-rate
// snapshot. Mirrors the established overlay pattern (see
// install-fiat-liquidity-overlay.js): safe on an empty database, safe on a
// populated production database, safe to re-run any number of times.
//
// Structures installed:
//   • CHECK ("User"."nativeGhsBalance" >= 0) — Prisma cannot express CHECK
//     constraints in the schema language, so the floor guard lives here
//     (the column itself is created by prisma db push / the schema).
//   • FxSavedRate indexes + CHECK constraints (canonical pair, positive
//     rate, honest demo provenance). The table itself is created by prisma
//     db push; the CREATE TABLE IF NOT EXISTS below keeps this overlay safe
//     even when db push has not run yet.
//   • The EXPLICIT DEMO RATE SEED (1 USDC = GHS 12.03, isDemoSeed = true,
//     source DEMO_SEED) — only when the environment is a disposable test
//     database (DATABASE_URL contains "test") or demo seeding is explicitly
//     requested via DEMO_RATE_SEED. The seed NEVER overwrites a genuine
//     saved observation and is display-eligible only in demo/test
//     environments (fxRateSnapshotService.getSavedRateForDisplay enforces
//     the read side; production reads simply see null).
//
// Release-chain contract (mirrors every other overlay): wired into
// `npm run release`, the CI test workflow, financial-durability workflow,
// and the converge prod-branch chain — see docs/native-ghs-fx-audit.md.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  // ── User.nativeGhsBalance floor guard ─────────────────────────────────
  // A negative native-GHS wallet is a bookkeeping defect, never a state the
  // application may write. CAS-guarded debits already prevent overdraft; the
  // CHECK is the database's independent backstop.
  `ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_nativeGhsBalance_nonnegative";`,
  `ALTER TABLE "User" ADD CONSTRAINT "User_nativeGhsBalance_nonnegative"
     CHECK ("nativeGhsBalance" >= 0);`,

  // ── FxSavedRate table (kept for db-push-less installs) + guards ────────
  `CREATE TABLE IF NOT EXISTS "FxSavedRate" (
    "id" TEXT NOT NULL,
    "pair" VARCHAR(16) NOT NULL,
    "rate" DECIMAL(20,8) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemoSeed" BOOLEAN NOT NULL DEFAULT false,
    "validation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FxSavedRate_pkey" PRIMARY KEY ("id")
  );`,
  `DROP INDEX IF EXISTS "FxSavedRate_pair_key";`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FxSavedRate_pair_key" ON "FxSavedRate"("pair");`,
  `CREATE INDEX IF NOT EXISTS "FxSavedRate_pair_savedAt_idx" ON "FxSavedRate"("pair", "savedAt" DESC);`,
  // Only the canonical pair may be persisted, and only positive rates.
  `ALTER TABLE "FxSavedRate" DROP CONSTRAINT IF EXISTS "FxSavedRate_pair_canonical";`,
  `ALTER TABLE "FxSavedRate" ADD CONSTRAINT "FxSavedRate_pair_canonical"
     CHECK ("pair" = 'USDC/GHS');`,
  `ALTER TABLE "FxSavedRate" DROP CONSTRAINT IF EXISTS "FxSavedRate_rate_positive";`,
  `ALTER TABLE "FxSavedRate" ADD CONSTRAINT "FxSavedRate_rate_positive"
     CHECK ("rate" > 0);`,
  // Provenance discipline: a demo row must SAY it is a demo row; a non-demo
  // row must never carry the demo marker or demo source label.
  `ALTER TABLE "FxSavedRate" DROP CONSTRAINT IF EXISTS "FxSavedRate_demo_honesty";`,
  `ALTER TABLE "FxSavedRate" ADD CONSTRAINT "FxSavedRate_demo_honesty"
     CHECK (("isDemoSeed" = true AND "source" = 'DEMO_SEED')
         OR ("isDemoSeed" = false AND "source" <> 'DEMO_SEED'));`,
];

async function installGhsWalletOverlay() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err: err.message, statement: statement.slice(0, 80) },
        '[install-ghs-wallet-overlay] statement failed');
      throw err;
    }
  }
  logger.info('[install-ghs-wallet-overlay] GHS wallet + FX saved-rate structures verified (idempotent)');

  // ── Demo rate seed (demo/test databases only) ──────────────────────────
  const dbUrl = String(process.env.DATABASE_URL || '');
  const isDisposableTestDb = /test/i.test(dbUrl);
  const demoExplicit = ['1', 'true', 'on'].includes(String(process.env.DEMO_RATE_SEED ?? '').toLowerCase());

  if (isDisposableTestDb || demoExplicit) {
    const { seedDemoRateSnapshot } = require('../src/services/fxRateSnapshotService');
    const result = await seedDemoRateSnapshot({ prisma });
    if (result.saved) {
      logger.info('[install-ghs-wallet-overlay] demo rate seeded: 1 USDC = GHS 12.03 (DEMO_SEED, display-only)');
    } else {
      logger.info(`[install-ghs-wallet-overlay] demo seed skipped: ${result.reason}`);
    }
  } else {
    logger.info('[install-ghs-wallet-overlay] production database: demo rate NOT seeded (display fallback stays empty until a genuine observation arrives)');
  }
}

module.exports = { installGhsWalletOverlay };

if (require.main === module) {
  installGhsWalletOverlay()
    .catch((err) => {
      logger.error({ err: err.message }, '[install-ghs-wallet-overlay] FAILED');
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
