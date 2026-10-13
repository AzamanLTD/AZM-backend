#!/usr/bin/env node
// Runtime schema convergence for objects already used by the production
// application but historically provisioned only by Prisma migrations.
// Production Render is Free-tier: its pre-deploy command (npm run release) is
// skipped, so these additive, idempotent statements must run as an installer.
//
// Safety contract:
// - no business/financial rows are seeded, rewritten, or deleted;
// - SmartRouteRun.updatedAt is initialized from createdAt only where NULL;
//   repeated runs never reset existing lease timestamps;
// - rate-provenance timestamps remain NULL unless a genuine external update
//   writes them (never fabricate freshness from lastRateSync).

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  // Smart Route recovery requires a lease timestamp. Preserve any existing
  // updatedAt values; initialize only missing/NULL values to createdAt.
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);`,
  `UPDATE "SmartRouteRun" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;`,
  `ALTER TABLE "SmartRouteRun" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;`,
  `ALTER TABLE "SmartRouteRun" ALTER COLUMN "updatedAt" SET NOT NULL;`,

  // Truthful oracle provenance. Deliberately no historical backfill.
  `ALTER TABLE "GlobalSettings" ADD COLUMN IF NOT EXISTS "lastExternalSync" TIMESTAMP(3);`,
  `ALTER TABLE "GlobalSettings" ADD COLUMN IF NOT EXISTS "lastAdminSetAt" TIMESTAMP(3);`,
  `ALTER TABLE "GlobalSettings" ADD COLUMN IF NOT EXISTS "lastEchoAt" TIMESTAMP(3);`,

  // §P.4 authoritative ledger schema, mirrored from
  // prisma/migrations/20260918100000_p4_liability_ledger/migration.sql.
  `DO $azm_runtime$ BEGIN
    CREATE TYPE "LedgerAccountClass" AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','CLEARING','RESTRICTED');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $azm_runtime$;`,
  `DO $azm_runtime$ BEGIN
    CREATE TYPE "LedgerNormalSide" AS ENUM ('DEBIT','CREDIT');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $azm_runtime$;`,
  `DO $azm_runtime$ BEGIN
    CREATE TYPE "RestrictedObligationStatus" AS ENUM ('ACTIVE','RELEASED','CANCELLED');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $azm_runtime$;`,
  `DO $azm_runtime$ BEGIN
    CREATE TYPE "ReserveInclusionPolicy" AS ENUM ('INCLUDED_IN_RESERVE_DENOMINATOR','EXCLUDED_FROM_RESERVE_DENOMINATOR');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $azm_runtime$;`,
  `ALTER TYPE "JournalEntryType" ADD VALUE IF NOT EXISTS 'ASSET_CONVERSION';`,

  `ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "ledgerTransactionId" VARCHAR(36);`,
  `ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "lineNumber" INTEGER;`,
  `CREATE INDEX IF NOT EXISTS "JournalEntry_ledgerTransactionId_idx" ON "JournalEntry"("ledgerTransactionId");`,
  `CREATE INDEX IF NOT EXISTS "JournalEntry_account_ledgerTransactionId_idx" ON "JournalEntry"("account","ledgerTransactionId");`,

  `CREATE TABLE IF NOT EXISTS "LedgerAccount" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "accountClass" "LedgerAccountClass" NOT NULL,
    "normalSide" "LedgerNormalSide" NOT NULL,
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "network" VARCHAR(20),
    "userId" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LedgerAccount_code_key" ON "LedgerAccount"("code");`,
  `CREATE INDEX IF NOT EXISTS "LedgerAccount_userId_idx" ON "LedgerAccount"("userId");`,
  `CREATE INDEX IF NOT EXISTS "LedgerAccount_accountClass_status_idx" ON "LedgerAccount"("accountClass","status");`,

  `CREATE TABLE IF NOT EXISTS "LedgerTransaction" (
    "id" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(140) NOT NULL,
    "entryType" "JournalEntryType" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(100),
    "userId" INTEGER,
    "relatedEntity" VARCHAR(50),
    "relatedEntityId" TEXT,
    "postingHash" VARCHAR(64) NOT NULL,
    "metadata" JSONB,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");`,
  `CREATE INDEX IF NOT EXISTS "LedgerTransaction_relatedEntity_relatedEntityId_idx" ON "LedgerTransaction"("relatedEntity","relatedEntityId");`,
  `CREATE INDEX IF NOT EXISTS "LedgerTransaction_userId_postedAt_idx" ON "LedgerTransaction"("userId","postedAt" DESC);`,
  `CREATE INDEX IF NOT EXISTS "LedgerTransaction_entryType_postedAt_idx" ON "LedgerTransaction"("entryType","postedAt" DESC);`,
  `ALTER TABLE "LedgerTransaction" ADD COLUMN IF NOT EXISTS "conversionIdentity" VARCHAR(140);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LedgerTransaction_conversionIdentity_key" ON "LedgerTransaction"("conversionIdentity");`,

  `CREATE TABLE IF NOT EXISTS "RestrictedObligation" (
    "id" TEXT NOT NULL,
    "reference" VARCHAR(140) NOT NULL,
    "sourceType" VARCHAR(40) NOT NULL,
    "sourceEntity" VARCHAR(50),
    "sourceEntityId" VARCHAR(100),
    "userId" INTEGER,
    "asset" VARCHAR(20) NOT NULL DEFAULT 'USDC',
    "network" VARCHAR(20),
    "amount" DECIMAL(20,8) NOT NULL,
    "status" "RestrictedObligationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reserveInclusionPolicy" "ReserveInclusionPolicy" NOT NULL DEFAULT 'INCLUDED_IN_RESERVE_DENOMINATOR',
    "ledgerTransactionId" VARCHAR(36),
    "releaseLedgerTransactionId" VARCHAR(36),
    "domainStateRef" JSONB,
    "releasedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RestrictedObligation_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "RestrictedObligation_reference_key" ON "RestrictedObligation"("reference");`,
  `CREATE INDEX IF NOT EXISTS "RestrictedObligation_sourceType_status_idx" ON "RestrictedObligation"("sourceType","status");`,
  `CREATE INDEX IF NOT EXISTS "RestrictedObligation_userId_status_idx" ON "RestrictedObligation"("userId","status");`,
  `CREATE INDEX IF NOT EXISTS "RestrictedObligation_status_asset_idx" ON "RestrictedObligation"("status","asset");`,

  `DO $azm_runtime$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'JournalEntry_ledgerTransactionId_fkey'
        AND conrelid = '"JournalEntry"'::regclass
    ) THEN
      ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_ledgerTransactionId_fkey"
        FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
   END $azm_runtime$;`,
];

async function installRuntimeSchemaGaps(client = prisma) {
  for (const statement of STATEMENTS) {
    await client.$executeRawUnsafe(statement);
  }
  return { applied: STATEMENTS.length };
}

async function main() {
  const result = await installRuntimeSchemaGaps();
  logger.info(result, '[runtime-schema-gaps] required runtime schema converged (idempotent)');
}

if (require.main === module) {
  main()
    .catch((err) => {
      logger.error({ err: err && err.message }, '[runtime-schema-gaps] install failed');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { STATEMENTS, installRuntimeSchemaGaps };
