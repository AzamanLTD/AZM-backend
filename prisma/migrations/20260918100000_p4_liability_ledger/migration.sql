-- §P.4 Authoritative Liability Ledger — additive, idempotent-safe DDL.
-- No historical rows are modified; JournalEntry gains NULLABLE link columns.

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LedgerAccountClass" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'CLEARING', 'RESTRICTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LedgerNormalSide" AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RestrictedObligationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReserveInclusionPolicy" AS ENUM ('INCLUDED_IN_RESERVE_DENOMINATOR', 'EXCLUDED_FROM_RESERVE_DENOMINATOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── JournalEntry additive columns ───────────────────────────────────────────
ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "ledgerTransactionId" VARCHAR(36);
ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "lineNumber" INTEGER;
CREATE INDEX IF NOT EXISTS "JournalEntry_ledgerTransactionId_idx" ON "JournalEntry"("ledgerTransactionId");
CREATE INDEX IF NOT EXISTS "JournalEntry_account_ledgerTransactionId_idx" ON "JournalEntry"("account", "ledgerTransactionId");

-- ── LedgerAccount catalog ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LedgerAccount" (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerAccount_code_key" ON "LedgerAccount"("code");
CREATE INDEX IF NOT EXISTS "LedgerAccount_userId_idx" ON "LedgerAccount"("userId");
CREATE INDEX IF NOT EXISTS "LedgerAccount_accountClass_status_idx" ON "LedgerAccount"("accountClass", "status");

-- ── LedgerTransaction posting group ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LedgerTransaction" (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "LedgerTransaction_relatedEntity_relatedEntityId_idx" ON "LedgerTransaction"("relatedEntity", "relatedEntityId");
CREATE INDEX IF NOT EXISTS "LedgerTransaction_userId_postedAt_idx" ON "LedgerTransaction"("userId", "postedAt" DESC);
CREATE INDEX IF NOT EXISTS "LedgerTransaction_entryType_postedAt_idx" ON "LedgerTransaction"("entryType", "postedAt" DESC);

-- ── RestrictedObligation ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RestrictedObligation" (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS "RestrictedObligation_reference_key" ON "RestrictedObligation"("reference");
CREATE INDEX IF NOT EXISTS "RestrictedObligation_sourceType_status_idx" ON "RestrictedObligation"("sourceType", "status");
CREATE INDEX IF NOT EXISTS "RestrictedObligation_userId_status_idx" ON "RestrictedObligation"("userId", "status");
CREATE INDEX IF NOT EXISTS "RestrictedObligation_status_asset_idx" ON "RestrictedObligation"("status", "asset");

-- FK from JournalEntry lines to their posting group (additive; null-safe).
DO $$ BEGIN
  ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_ledgerTransactionId_fkey"
    FOREIGN KEY ("ledgerTransactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
