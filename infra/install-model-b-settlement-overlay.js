#!/usr/bin/env node
// Idempotent additive installer for the §P.5-E Model B settlement overlay:
// the GlobalSettings rollout flag + the durable settlement economic identity
// table (with its raw CHECKs, which prisma db push cannot express).
// Production is db-push managed; this installer keeps a fresh install and the
// release chain convergent with prisma/schema.prisma and the P5-E migration.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `ALTER TABLE "GlobalSettings"
     ADD COLUMN IF NOT EXISTS "modelBSettlementEnabled" BOOLEAN NOT NULL DEFAULT false;`,

  `CREATE TABLE IF NOT EXISTS "ModelBSettlement" (
    "id" SERIAL NOT NULL,
    "reference" VARCHAR(140) NOT NULL,
    "transactionHistoryId" VARCHAR(36) NOT NULL,
    "quoteId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "selectedRoute" TEXT,
    "routeProviderRail" TEXT,
    "routePolicyVersion" TEXT,
    "provider" VARCHAR(40) NOT NULL,
    "providerRef" TEXT,
    "evidenceDedupKey" VARCHAR(140) NOT NULL,
    "quotedGhs" DECIMAL(20,2) NOT NULL,
    "quotedRateGhsPerUsdc" DECIMAL(20,8) NOT NULL,
    "quotedUsdc" DECIMAL(20,8) NOT NULL,
    "settledGhs" DECIMAL(20,2) NOT NULL,
    "settledUsdc" DECIMAL(20,8) NOT NULL,
    "costBasisGhsTotal" DECIMAL(20,8) NOT NULL,
    "costAllocationResidualGhs" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "marginGhs" DECIMAL(20,8) NOT NULL,
    "providerFeeGhs" DECIMAL(20,2),
    "conversionIdentity" VARCHAR(140) NOT NULL,
    "conversionLedgerTxnId" VARCHAR(36) NOT NULL,
    "depositLedgerTxnId" VARCHAR(36) NOT NULL,
    "lotAllocations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelBSettlement_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ModelBSettlement_reference_key" ON "ModelBSettlement"("reference");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ModelBSettlement_conversionIdentity_key" ON "ModelBSettlement"("conversionIdentity");`,
  `CREATE INDEX IF NOT EXISTS "ModelBSettlement_quoteId_idx" ON "ModelBSettlement"("quoteId");`,
  `CREATE INDEX IF NOT EXISTS "ModelBSettlement_userId_idx" ON "ModelBSettlement"("userId");`,
  `CREATE INDEX IF NOT EXISTS "ModelBSettlement_transactionHistoryId_idx" ON "ModelBSettlement"("transactionHistoryId");`,
  `CREATE INDEX IF NOT EXISTS "ModelBSettlement_evidenceDedupKey_idx" ON "ModelBSettlement"("evidenceDedupKey");`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModelBSettlement_amounts_positive') THEN
       ALTER TABLE "ModelBSettlement" ADD CONSTRAINT "ModelBSettlement_amounts_positive"
         CHECK ("quotedGhs" > 0 AND "settledGhs" > 0 AND "quotedUsdc" > 0 AND "settledUsdc" > 0);
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModelBSettlement_quote_consistency') THEN
       ALTER TABLE "ModelBSettlement" ADD CONSTRAINT "ModelBSettlement_quote_consistency"
         CHECK ("quotedRateGhsPerUsdc" > 0);
     END IF;
   END $$;`,

  // §P.5-E audit r1: structural inventory-authority gate. Eligibility is
  // false by default and granted by no production code path — only a future,
  // evidence-backed acquisition authority may set it. Model B settlement
  // claims ONLY eligible lots; quantity alone can never fund a customer
  // liability.
  `ALTER TABLE "InventoryLot"
     ADD COLUMN IF NOT EXISTS "eligibleForModelBSettlement" BOOLEAN NOT NULL DEFAULT false;`,
  `CREATE INDEX IF NOT EXISTS "InventoryLot_eligible_status_idx"
     ON "InventoryLot"("eligibleForModelBSettlement", "status");`,
];

async function main() {
  for (const statement of STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
  logger.info('[install:model-b-settlement] overlay applied (idempotent)');
}

if (require.main === module) {
  main()
    .catch((err) => {
      logger.error({ err }, '[install:model-b-settlement] FAILED');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { STATEMENTS, main };
