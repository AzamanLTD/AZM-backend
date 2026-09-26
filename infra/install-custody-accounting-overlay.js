#!/usr/bin/env node
// Idempotent additive installer for the §P.3 custody accounting layer
// (financial architecture §P.3, 2026-09-17).
//
// Production is db-push managed, so the partial unique indexes — which Prisma
// db push cannot express — are installed idempotently here at boot (mirrored
// by prisma/migrations/20260917180000_custody_accounting/migration.sql).
// Running this installer repeatedly is safe: every statement is guarded.
//
// This installer performs NO financial-data mutation: it only creates the
// custody accounting structures (tables, indexes, additive enum values and
// nullable snapshot columns). Balances, journals, and history are untouched.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'JournalEntryType' AND e.enumlabel = 'CUSTODY_DEPOSIT') THEN
    ALTER TYPE "JournalEntryType" ADD VALUE 'CUSTODY_DEPOSIT';
  END IF;
END $$;`,
  `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'JournalEntryType' AND e.enumlabel = 'CUSTODY_SWEEP') THEN
    ALTER TYPE "JournalEntryType" ADD VALUE 'CUSTODY_SWEEP';
  END IF;
END $$;`,
  `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'JournalEntryType' AND e.enumlabel = 'CUSTODY_WITHDRAWAL') THEN
    ALTER TYPE "JournalEntryType" ADD VALUE 'CUSTODY_WITHDRAWAL';
  END IF;
END $$;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "usdcLiabilityTotal" DECIMAL(20, 8);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "evidenceLinkedLiabilityTotal" DECIMAL(20, 8);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "unclassifiedExposure" DECIMAL(20, 8);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "eligibleReserveTotal" DECIMAL(20, 8);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "restrictedObligationsTotal" DECIMAL(20, 8);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "restrictedObligationsAvailable" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "liabilityAttestation" VARCHAR(30);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "evidenceStatus" VARCHAR(30);`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "custodyAccountCount" INTEGER;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "acceptedEvidenceCount" INTEGER;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "missingEvidenceCount" INTEGER;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "evidenceSummary" JSONB;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "assetIdentity" JSONB;`,
  `ALTER TABLE "ProofOfReservesSnapshot"
  ADD COLUMN IF NOT EXISTS "liabilityBreakdown" JSONB;`,
  `CREATE TABLE IF NOT EXISTS "CustodyAccount" (
    "id" TEXT NOT NULL,
    "tier" VARCHAR(30) NOT NULL,
    "network" VARCHAR(20) NOT NULL DEFAULT 'POLYGON',
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "contractAddress" VARCHAR(42) NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "control" VARCHAR(40) NOT NULL DEFAULT 'PLATFORM_KMS_CUSTODY',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "userId" INTEGER,
    "walletAddressId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustodyAccount_pkey" PRIMARY KEY ("id")
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyAccount_address_network_asset_contract_key"
    ON "CustodyAccount"("address", "network", "asset", "contractAddress");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyAccount_walletAddressId_key"
    ON "CustodyAccount"("walletAddressId")
    WHERE "walletAddressId" IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS "CustodyAccount_tier_status_idx"
    ON "CustodyAccount"("tier", "status");`,
  `CREATE INDEX IF NOT EXISTS "CustodyAccount_userId_idx"
    ON "CustodyAccount"("userId");`,
  `CREATE TABLE IF NOT EXISTS "CustodyMovement" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "network" VARCHAR(20) NOT NULL DEFAULT 'POLYGON',
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "contractAddress" VARCHAR(42) NOT NULL,
    "amountBaseUnits" BIGINT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 6,
    "sourceAccountId" TEXT,
    "destinationAccountId" TEXT,
    "fromAddress" VARCHAR(42),
    "toAddress" VARCHAR(42),
    "custodyExecutionId" TEXT,
    "transactionHistoryId" TEXT,
    "txHash" TEXT,
    "evidenceId" TEXT,
    "evidenceSource" VARCHAR(50),
    "verificationDetail" JSONB,
    "failureReason" VARCHAR(60),
    "metadata" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustodyMovement_pkey" PRIMARY KEY ("id")
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyMovement_idempotencyKey_key"
    ON "CustodyMovement"("idempotencyKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyMovement_custodyExecutionId_key"
    ON "CustodyMovement"("custodyExecutionId")
    WHERE "custodyExecutionId" IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS "CustodyMovement_kind_status_idx"
    ON "CustodyMovement"("kind", "status");`,
  `CREATE INDEX IF NOT EXISTS "CustodyMovement_sourceAccountId_idx"
    ON "CustodyMovement"("sourceAccountId");`,
  `CREATE INDEX IF NOT EXISTS "CustodyMovement_destinationAccountId_idx"
    ON "CustodyMovement"("destinationAccountId");`,
  `CREATE INDEX IF NOT EXISTS "CustodyMovement_txHash_idx"
    ON "CustodyMovement"("txHash");`,
  `CREATE INDEX IF NOT EXISTS "CustodyMovement_status_createdAt_idx"
    ON "CustodyMovement"("status", "createdAt" DESC);`,
  `CREATE TABLE IF NOT EXISTS "CustodyEvidence" (
    "id" TEXT NOT NULL,
    "custodyAccountId" TEXT NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "scope" VARCHAR(30) NOT NULL DEFAULT 'ACCOUNT_BALANCE',
    "network" VARCHAR(20) NOT NULL,
    "asset" VARCHAR(20) NOT NULL,
    "contractAddress" VARCHAR(42) NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "balanceBaseUnits" BIGINT,
    "amountBaseUnits" BIGINT,
    "txHash" VARCHAR(66),
    "blockReference" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "supersededById" TEXT,
    "rejectionReason" VARCHAR(60),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustodyEvidence_pkey" PRIMARY KEY ("id")
);`,
  // Drop-then-create: converges ANY pre-existing variant of this index
  // (e.g. a DB built with an earlier unscoped predicate) onto the scoped
  // ACCOUNT_BALANCE semantics. Plain CREATE UNIQUE IF NOT EXISTS would keep
  // a stale unscoped index forever.
  `DROP INDEX IF EXISTS "CustodyEvidence_account_active_key";`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyEvidence_account_active_key"
    ON "CustodyEvidence"("custodyAccountId")
    WHERE "scope" = 'ACCOUNT_BALANCE' AND "status" = 'ACTIVE';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CustodyEvidence_account_tx_key"
    ON "CustodyEvidence"("custodyAccountId", "txHash")
    WHERE "scope" = 'TRANSACTION' AND "txHash" IS NOT NULL AND "status" = 'ACTIVE';`,
  `CREATE INDEX IF NOT EXISTS "CustodyEvidence_account_createdAt_idx"
    ON "CustodyEvidence"("custodyAccountId", "createdAt" DESC);`,
  `CREATE INDEX IF NOT EXISTS "CustodyEvidence_status_idx"
    ON "CustodyEvidence"("status");`,
  `CREATE INDEX IF NOT EXISTS "CustodyEvidence_scope_status_idx"
    ON "CustodyEvidence"("scope", "status");`,
  `CREATE TABLE IF NOT EXISTS "ProofOfReservesLeaf" (
    "id" SERIAL NOT NULL,
    "snapshotId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "availableBalance" DECIMAL(20,8) NOT NULL,
    "escrowLockedBalance" DECIMAL(20,8) NOT NULL,
    "vendorUnallocatedBalance" DECIMAL(20,8) NOT NULL,
    "disputeEscrowBalance" DECIMAL(20,8) NOT NULL,
    "leafHash" VARCHAR(64) NOT NULL,
    CONSTRAINT "ProofOfReservesLeaf_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProofOfReservesLeaf_snapshotId_fkey"
      FOREIGN KEY ("snapshotId") REFERENCES "ProofOfReservesSnapshot"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProofOfReservesLeaf_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProofOfReservesLeaf_snapshotId_userId_key"
      UNIQUE ("snapshotId", "userId")
);`,
  `CREATE INDEX IF NOT EXISTS "ProofOfReservesLeaf_snapshotId_userId_idx"
  ON "ProofOfReservesLeaf"("snapshotId", "userId");`,
  `CREATE INDEX IF NOT EXISTS "ProofOfReservesLeaf_userId_idx"
  ON "ProofOfReservesLeaf"("userId");;`,];

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      // Enum additions can race with a concurrent install; a duplicate value
      // or duplicate object is a successful no-op for an idempotent installer.
      const msg = String((err && err.message) || '');
      if ((err && err.code === '23505') || /duplicate key|already exists|already an object of/i.test(msg)) {
        logger.warn({ detail: msg.slice(0, 200) }, '[custody-accounting-overlay] already present — skipping');
        continue;
      }
      logger.error({ err: msg }, '[custody-accounting-overlay] statement failed');
      throw err;
    }
  }
  logger.info('[custody-accounting-overlay] §P.3 custody accounting structures installed (idempotent)');
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err && err.message }, '[custody-accounting-overlay] install failed');
    prisma.$disconnect().finally(() => process.exit(1));
  });
