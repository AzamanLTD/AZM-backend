#!/usr/bin/env node
// Idempotent additive installer for the §P.5-D evidence-backed GHS liquidity
// authority (docs/p5d-ghs-liquidity-authority.md).
//
// Production is db-push managed, so the DB CHECK constraints Prisma cannot
// express, the singleton FiatLiquidityState row and the GlobalSettings flag
// column are installed idempotently here (mirrored by
// prisma/migrations/20260919060000_p5d_fiat_liquidity/migration.sql).
// Running this installer repeatedly is safe: every statement is guarded.
//
// This installer performs NO financial-data mutation: the tables are created
// empty and the singleton state row starts at exact zero. It never seeds,
// backfills or reinterprets liquidity.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `ALTER TABLE "GlobalSettings"
     ADD COLUMN IF NOT EXISTS "fiatLiquidityAuthorityEnabled" BOOLEAN NOT NULL DEFAULT false;`,

  `CREATE TABLE IF NOT EXISTS "FiatProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "rail" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerRef" TEXT,
    "dedupKey" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,2),
    "relatedReference" TEXT,
    "raw" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FiatProviderEvent_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FiatProviderEvent_dedupKey_key"
     ON "FiatProviderEvent"("dedupKey");`,
  `CREATE INDEX IF NOT EXISTS "FiatProviderEvent_provider_providerRef_idx"
     ON "FiatProviderEvent"("provider", "providerRef");`,
  `CREATE INDEX IF NOT EXISTS "FiatProviderEvent_relatedReference_idx"
     ON "FiatProviderEvent"("relatedReference");`,
  `CREATE INDEX IF NOT EXISTS "FiatProviderEvent_direction_status_idx"
     ON "FiatProviderEvent"("direction", "status");`,
  `ALTER TABLE "FiatProviderEvent" DROP CONSTRAINT IF EXISTS "FiatProviderEvent_direction_valid";`,
  `ALTER TABLE "FiatProviderEvent" ADD CONSTRAINT "FiatProviderEvent_direction_valid"
     CHECK ("direction" IN ('INBOUND', 'OUTBOUND'));`,
  `ALTER TABLE "FiatProviderEvent" DROP CONSTRAINT IF EXISTS "FiatProviderEvent_amount_present";`,
  `ALTER TABLE "FiatProviderEvent" ADD CONSTRAINT "FiatProviderEvent_amount_present"
     CHECK (("amountGhs" IS NOT NULL AND "amountGhs" > 0) OR "direction" = 'OUTBOUND');`,

  `CREATE TABLE IF NOT EXISTS "FiatLiquidityReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "rail" TEXT,
    "providerRef" TEXT,
    "dedupKey" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "route" TEXT,
    "relatedTransactionId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiatLiquidityReceipt_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FiatLiquidityReceipt_dedupKey_key"
     ON "FiatLiquidityReceipt"("dedupKey");`,
  `CREATE INDEX IF NOT EXISTS "FiatLiquidityReceipt_status_idx" ON "FiatLiquidityReceipt"("status");`,
  `CREATE INDEX IF NOT EXISTS "FiatLiquidityReceipt_provider_providerRef_idx"
     ON "FiatLiquidityReceipt"("provider", "providerRef");`,
  `CREATE INDEX IF NOT EXISTS "FiatLiquidityReceipt_relatedTransactionId_idx"
     ON "FiatLiquidityReceipt"("relatedTransactionId");`,

  // r15 R15-A: at most ONE AVAILABLE receipt may exist for a non-null
  // relatedTransactionId. The DB — not application reads — is the race
  // authority for concurrent confirmReconciliationMatch claims.
  `CREATE UNIQUE INDEX IF NOT EXISTS "FiatLiquidityReceipt_availableRelatedTx_unique"
     ON "FiatLiquidityReceipt"("relatedTransactionId")
     WHERE "status" = 'AVAILABLE' AND "relatedTransactionId" IS NOT NULL;`,

  // §P.5-D audit r14 (§B): durable receipt replay identity — the deposit
  // txHash binding and the backing provider observation become columns so
  // the replay identity NEVER depends on arbitrary raw JSON evidence.
  `ALTER TABLE "FiatLiquidityReceipt" ADD COLUMN IF NOT EXISTS "reference" TEXT;`,
  `ALTER TABLE "FiatLiquidityReceipt" ADD COLUMN IF NOT EXISTS "eventDedupKey" TEXT;`,
  `CREATE INDEX IF NOT EXISTS "FiatLiquidityReceipt_eventDedupKey_idx"
     ON "FiatLiquidityReceipt"("eventDedupKey");`,
  `ALTER TABLE "FiatLiquidityReceipt" DROP CONSTRAINT IF EXISTS "FiatLiquidityReceipt_amount_positive";`,
  `ALTER TABLE "FiatLiquidityReceipt" ADD CONSTRAINT "FiatLiquidityReceipt_amount_positive"
     CHECK ("amountGhs" > 0);`,
  `ALTER TABLE "FiatLiquidityReceipt" DROP CONSTRAINT IF EXISTS "FiatLiquidityReceipt_status_valid";`,
  `ALTER TABLE "FiatLiquidityReceipt" ADD CONSTRAINT "FiatLiquidityReceipt_status_valid"
     CHECK ("status" IN ('RECEIVED', 'AVAILABLE', 'UNMATCHED', 'RECONCILIATION_REQUIRED', 'REVERSED'));`,

  `CREATE TABLE IF NOT EXISTS "FiatLiquidityReservation" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "provider" TEXT NOT NULL,
    "rail" TEXT,
    "destination" TEXT,
    "relatedTransactionId" TEXT,
    "providerRef" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiatLiquidityReservation_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FiatLiquidityReservation_reference_key"
     ON "FiatLiquidityReservation"("reference");`,
  `CREATE INDEX IF NOT EXISTS "FiatLiquidityReservation_status_idx"
     ON "FiatLiquidityReservation"("status");`,
  `CREATE INDEX IF NOT EXISTS "FiatLiquidityReservation_provider_providerRef_idx"
     ON "FiatLiquidityReservation"("provider", "providerRef");`,
  `ALTER TABLE "FiatLiquidityReservation" DROP CONSTRAINT IF EXISTS "FiatLiquidityReservation_amount_positive";`,
  `ALTER TABLE "FiatLiquidityReservation" ADD CONSTRAINT "FiatLiquidityReservation_amount_positive"
     CHECK ("amountGhs" > 0);`,
  `ALTER TABLE "FiatLiquidityReservation" DROP CONSTRAINT IF EXISTS "FiatLiquidityReservation_status_valid";`,
  `ALTER TABLE "FiatLiquidityReservation" ADD CONSTRAINT "FiatLiquidityReservation_status_valid"
     CHECK ("status" IN ('RESERVED', 'IN_TRANSIT', 'PAID_OUT', 'RELEASED', 'RECONCILIATION_REQUIRED'));`,

  `CREATE TABLE IF NOT EXISTS "FiatLiquidityState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "availableGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "reservedGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "inTransitGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "paidOutGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "reconciliationHeldGhs" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FiatLiquidityState_pkey" PRIMARY KEY ("id")
  );`,
  `ALTER TABLE "FiatLiquidityState" DROP CONSTRAINT IF EXISTS "FiatLiquidityState_totals_nonneg";`,
  `ALTER TABLE "FiatLiquidityState" ADD CONSTRAINT "FiatLiquidityState_totals_nonneg"
     CHECK ("availableGhs" >= 0 AND "reservedGhs" >= 0 AND "inTransitGhs" >= 0 AND "paidOutGhs" >= 0 AND "reconciliationHeldGhs" >= 0);`,

  // Existing deployments (pre-blocker-5 DBs) gain the new bucket column.
  `ALTER TABLE "FiatLiquidityState"
     ADD COLUMN IF NOT EXISTS "reconciliationHeldGhs" DECIMAL(20,2) NOT NULL DEFAULT 0;`,

  // Singleton zero-state row (deterministic id=1). No financial data.
  `INSERT INTO "FiatLiquidityState" ("id", "availableGhs", "reservedGhs", "inTransitGhs", "paidOutGhs", "reconciliationHeldGhs", "updatedAt")
     VALUES (1, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP)
   ON CONFLICT ("id") DO NOTHING;`,
];

async function installFiatLiquidityOverlay() {
  // r15 R15-A duplicate preflight (READ-ONLY): the partial unique index
  // enforcing "at most one AVAILABLE receipt per relatedTransactionId"
  // cannot be applied over contradictory historical rows without PostgreSQL
  // failing the CREATE INDEX. We surface the offending rows FIRST, loudly,
  // with their identities — and NEVER auto-select a "winner": choosing among
  // historical double-claims requires human evidence review.
  const conflicting = await prisma.$queryRawUnsafe(`
    SELECT "relatedTransactionId", "dedupKey", "amountGhs", "confirmedAt"
    FROM "FiatLiquidityReceipt"
    WHERE "status" = 'AVAILABLE' AND "relatedTransactionId" IS NOT NULL
      AND "relatedTransactionId" IN (
        SELECT "relatedTransactionId" FROM "FiatLiquidityReceipt"
        WHERE "status" = 'AVAILABLE' AND "relatedTransactionId" IS NOT NULL
        GROUP BY "relatedTransactionId" HAVING COUNT(*) > 1
      )
    ORDER BY "relatedTransactionId", "confirmedAt"`);
  if (conflicting.length > 0) {
    logger.error({ conflicts: conflicting },
      '[install-fiat-liquidity-overlay] PRE-FLIGHT FAILURE: historical duplicate AVAILABLE receipts exist for the same deposit. '
      + 'The single-claim unique index will NOT be applied. Resolve the contradictory rows by evidence review (do NOT delete or reassign them blindly), then re-run.');
    const err = new Error('R15-A duplicate AVAILABLE receipt pre-flight failed: ' + conflicting.length + ' contradictory receipt rows across '
      + new Set(conflicting.map((r) => r.relatedTransactionId)).size + ' deposit(s). See log for identities.');
    err.code = 'R15A_DUPLICATE_AVAILABLE_RECEIPTS';
    throw err;
  }

  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err: err.message, statement: statement.slice(0, 80) },
        '[install-fiat-liquidity-overlay] statement failed');
      throw err;
    }
  }
  logger.info('[install-fiat-liquidity-overlay] liquidity authority structures verified (idempotent)');
}

module.exports = { installFiatLiquidityOverlay };

if (require.main === module) {
  installFiatLiquidityOverlay()
    .catch((err) => {
      logger.error({ err: err.message }, '[install-fiat-liquidity-overlay] FAILED');
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
