#!/usr/bin/env node
// Idempotent additive installer for the CustodyExecution boundary
// (financial architecture §P.2, 2026-09-17).
//
// Production is db-push managed, so the partial unique indexes — which Prisma
// db push cannot express — are installed idempotently here at boot (mirrored by
// prisma/migrations/20260917170000_custody_execution/migration.sql).
// Running this installer repeatedly is safe: every statement is IF NOT EXISTS.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "CustodyExecution" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "refId" TEXT,
    "walletAddressId" TEXT,
    "userId" INTEGER,
    "network" VARCHAR(20) NOT NULL DEFAULT 'POLYGON',
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "contractAddress" VARCHAR(42) NOT NULL,
    "fromAddress" VARCHAR(42) NOT NULL,
    "toAddress" VARCHAR(42) NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 6,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "provider" VARCHAR(30) NOT NULL DEFAULT 'TATUM_KMS',
    "tatumPendingId" VARCHAR(100),
    "txHash" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "errorClass" VARCHAR(40),
    "errorMessage" VARCHAR(500),
    "feeChargeBaseUnits" BIGINT,
    "estimatedNetworkCostBaseUnits" BIGINT,
    "realizedNetworkCostBaseUnits" BIGINT,
    "submittedAt" TIMESTAMP(3),
    "broadcastAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustodyExecution_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyExecution_idempotencyKey_key"
    ON "CustodyExecution"("idempotencyKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyExecution_txHash_key"
    ON "CustodyExecution"("txHash")
    WHERE "txHash" IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS "CustodyExecution_kind_refId_idx"
    ON "CustodyExecution"("kind", "refId");`,
  `CREATE INDEX IF NOT EXISTS "CustodyExecution_status_idx"
    ON "CustodyExecution"("status");`,
  `CREATE INDEX IF NOT EXISTS "CustodyExecution_walletAddressId_idx"
    ON "CustodyExecution"("walletAddressId");`,
  `CREATE INDEX IF NOT EXISTS "CustodyExecution_userId_idx"
    ON "CustodyExecution"("userId");`,
  // DB-enforced sweep-claim authority: exactly one in-flight sweep per source
  // WalletAddress across overlapping worker processes/instances.
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyExecution_one_inflight_sweep_per_wallet_idx"
    ON "CustodyExecution"("walletAddressId")
    WHERE "kind" = 'DEPOSIT_SWEEP'
      AND "status" IN ('REQUESTED','RESERVING','SUBMITTED','SIGNING','BROADCAST','CONFIRMING','RECONCILIATION_REQUIRED');`,
];

async function installCustodyExecutionOverlay(client = prisma) {
  const results = { applied: 0, skipped: 0, failed: 0 };
  for (const sql of STATEMENTS) {
    try {
      await client.$executeRawUnsafe(sql);
      results.applied += 1;
    } catch (err) {
      if (String(err.message).includes('already exists')) {
        results.skipped += 1;
      } else {
        results.failed += 1;
        logger.error({ err: err.message }, '[custody-execution-overlay] statement failed');
      }
    }
  }
  if (results.failed > 0) throw new Error('custody-execution overlay install failed');
  return results;
}

async function main() {
  try {
    const results = await installCustodyExecutionOverlay();
    logger.info(results, '[custody-execution-overlay] install complete');
  } catch (err) {
    logger.error({ err: err.message }, '[custody-execution-overlay] FATAL');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main();

module.exports = { installCustodyExecutionOverlay };
