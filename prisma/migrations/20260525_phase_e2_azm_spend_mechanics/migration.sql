-- Phase E2: AZM Spend Mechanics
-- Adds AzmSpendLog table for spend audit trail,
-- plus isBoosted/boostExpiresAt fields on Ad for ad-boost feature.

-- 1. Create AzmSpendLog table
CREATE TABLE "AzmSpendLog" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId"       INTEGER NOT NULL,
    "amount"       DOUBLE PRECISION NOT NULL,
    "reason"       TEXT NOT NULL,
    "source"       TEXT NOT NULL,
    "metadata"     JSONB,
    "balanceAfter" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AzmSpendLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AzmSpendLog_amount_positive" CHECK ("amount" > 0)
);

-- 2. Indexes for efficient querying
CREATE INDEX "AzmSpendLog_userId_createdAt_idx" ON "AzmSpendLog"("userId", "createdAt" DESC);
CREATE INDEX "AzmSpendLog_source_idx" ON "AzmSpendLog"("source");
CREATE INDEX "AzmSpendLog_userId_source_idx" ON "AzmSpendLog"("userId", "source");

-- 3. Foreign key
ALTER TABLE "AzmSpendLog" ADD CONSTRAINT "AzmSpendLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Add boost fields to Ad table
ALTER TABLE "Ad" ADD COLUMN "isBoosted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ad" ADD COLUMN "boostExpiresAt" TIMESTAMP(3);

-- 5. Index for marketplace boost sorting (boosted ads first)
CREATE INDEX "Ad_isBoosted_status_createdAt_idx" ON "Ad"("isBoosted" DESC, "status", "createdAt" DESC);
