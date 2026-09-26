-- CreateTable: JournalEntry (double-entry ledger)
CREATE TYPE "JournalEntryType" AS ENUM (
    'DEPOSIT',
    'WITHDRAWAL',
    'TRADE',
    'TRANSFER',
    'ESCROW_LOCK',
    'ESCROW_RELEASE',
    'ESCROW_REFUND',
    'VAULT_DEPOSIT',
    'VAULT_RELEASE',
    'SUSU_CONTRIBUTION',
    'SUSU_PAYOUT',
    'FEE',
    'REWARD',
    'ADJUSTMENT',
    'BUSINESS_PAYMENT',
    'SHARED_VAULT_DEPOSIT',
    'SHARED_VAULT_REFUND'
);

CREATE TABLE "JournalEntry" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "transactionId"   TEXT         NOT NULL,
    "entryType"       "JournalEntryType" NOT NULL,
    "account"         VARCHAR(80)  NOT NULL,
    "debit"            DECIMAL(20,8) NOT NULL DEFAULT 0,
    "credit"           DECIMAL(20,8) NOT NULL DEFAULT 0,
    "description"      VARCHAR(500) NOT NULL,
    "reference"        VARCHAR(100),
    "metadata"         JSONB,
    "userId"          INTEGER,
    "relatedEntity"   VARCHAR(50),
    "relatedEntityId" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "JournalEntry_transactionId_idx" ON "JournalEntry"("transactionId");
CREATE INDEX "JournalEntry_account_idx" ON "JournalEntry"("account");
CREATE INDEX "JournalEntry_userId_createdAt_idx" ON "JournalEntry"("userId", "createdAt" DESC);
CREATE INDEX "JournalEntry_entryType_createdAt_idx" ON "JournalEntry"("entryType", "createdAt" DESC);
CREATE INDEX "JournalEntry_relatedEntity_relatedEntityId_idx" ON "JournalEntry"("relatedEntity", "relatedEntityId");

-- FK to User (optional)
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
