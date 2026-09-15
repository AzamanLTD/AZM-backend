#!/usr/bin/env node
// Idempotent additive installer for the payout reconciliation infrastructure:
//   1. "ProviderSettlementAttempt"  — durable external-provider identity for
//      fiat settlement attempts (dedup + correlation without inference).
//   2. "ReconciliationException"    — durable operational queue for states
//      that cannot be safely auto-correlated or auto-repaired.
//   3. "Withdrawal"."transactionHistoryId" — nullable canonical-transaction
//      bridge used by the payout/reconciliation workers.
//
// Production is db-push managed, so these objects are installed after Prisma
// schema convergence rather than being treated as unmanaged objects that db
// push may remove. Idempotent: safe to run on every release.
//
// NOTE: the raw reference migrations (20260830_*) authored these columns as
// UUID, but "TransactionHistory"."id" is TEXT in the Prisma schema — those
// migrations could therefore never apply cleanly. This installer creates the
// same structures with TEXT keys that match the schema-managed reality; the
// migration SQLs have been corrected to match.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  // ── ProviderSettlementAttempt ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ProviderSettlementAttempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transactionHistoryId" TEXT NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "providerReference" VARCHAR(255) NOT NULL,
    "providerTransactionId" VARCHAR(255),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ,
    "failureReason" TEXT,
    "metadata" JSONB,
    CONSTRAINT "ProviderSettlementAttempt_pkey" PRIMARY KEY ("id")
  );`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'ProviderSettlementAttempt_transactionHistoryId_fkey'
    ) THEN
      ALTER TABLE "ProviderSettlementAttempt"
        ADD CONSTRAINT "ProviderSettlementAttempt_transactionHistoryId_fkey"
        FOREIGN KEY ("transactionHistoryId") REFERENCES "TransactionHistory"("id")
        ON DELETE CASCADE;
    END IF;
  END $$;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSettlementAttempt_provider_providerReference_key"
    ON "ProviderSettlementAttempt"("provider", "providerReference");`,
  `CREATE INDEX IF NOT EXISTS "ProviderSettlementAttempt_transactionHistoryId_idx"
    ON "ProviderSettlementAttempt"("transactionHistoryId");`,
  `CREATE INDEX IF NOT EXISTS "ProviderSettlementAttempt_status_lastSeenAt_idx"
    ON "ProviderSettlementAttempt"("status", "lastSeenAt");`,
  `CREATE INDEX IF NOT EXISTS "ProviderSettlementAttempt_providerTransactionId_idx"
    ON "ProviderSettlementAttempt"("providerTransactionId");`,

  // ── ReconciliationException ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "ReconciliationException" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(255) NOT NULL,
    "reference" VARCHAR(255),
    "reason" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    "details" JSONB,
    "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ,
    "resolvedBy" INTEGER,
    CONSTRAINT "ReconciliationException_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReconciliationException_entity_reason_open_key"
    ON "ReconciliationException"("entityType", "entityId", "reason")
    WHERE "status" = 'OPEN';`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationException_status_lastSeenAt_idx"
    ON "ReconciliationException"("status", "lastSeenAt");`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationException_reference_idx"
    ON "ReconciliationException"("reference");`,
  `CREATE INDEX IF NOT EXISTS "ReconciliationException_entity_idx"
    ON "ReconciliationException"("entityType", "entityId");`,

  // ── Withdrawal canonical-transaction bridge ──────────────────────────────
  `ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "transactionHistoryId" TEXT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Withdrawal_transactionHistoryId_key"
    ON "Withdrawal"("transactionHistoryId")
    WHERE "transactionHistoryId" IS NOT NULL;`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'Withdrawal_transactionHistoryId_fkey'
    ) THEN
      ALTER TABLE "Withdrawal"
        ADD CONSTRAINT "Withdrawal_transactionHistoryId_fkey"
        FOREIGN KEY ("transactionHistoryId") REFERENCES "TransactionHistory"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END $$;`,
];

async function installPayoutReconciliationInfra(client) {
  const db = client || prisma;
  const results = { ok: 0, failed: 0, errors: [] };

  for (const sql of STATEMENTS) {
    try {
      await db.$executeRawUnsafe(sql);
      results.ok += 1;
    } catch (err) {
      results.failed += 1;
      const head = sql.split('\n')[0].slice(0, 100);
      results.errors.push(`${head} … → ${err.message.split('\n')[0]}`);
      logger.error(`[install-payout-reconciliation-infra] ${head}: ${err.message}`);
    }
  }

  return results;
}

module.exports = { installPayoutReconciliationInfra };

if (require.main === module) {
  installPayoutReconciliationInfra()
    .then((result) => {
      logger.info(`[install-payout-reconciliation-infra] ${result.ok} ok, ${result.failed} failed`);
      if (result.failed) process.exitCode = 1;
    })
    .catch((err) => {
      logger.error({ err }, '[install-payout-reconciliation-infra] fatal');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
