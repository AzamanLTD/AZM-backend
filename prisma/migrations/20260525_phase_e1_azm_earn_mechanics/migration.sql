-- Phase E1: AZM Earn Mechanics
-- Adds AzmRewardLog table to track all AZM credit/debit events,
-- plus the AZM_REWARD transaction type for TransactionHistory.

-- 1. Add AZM_REWARD to TransactionType enum
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'AZM_REWARD';

-- 2. Create AzmRewardLog table
CREATE TABLE "AzmRewardLog" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId"    INTEGER NOT NULL,
    "amount"    DOUBLE PRECISION NOT NULL,
    "reason"    TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "metadata"  JSONB,
    "balanceAfter" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AzmRewardLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AzmRewardLog_amount_positive" CHECK ("amount" > 0)
);

-- 3. Indexes for efficient querying
CREATE INDEX "AzmRewardLog_userId_createdAt_idx" ON "AzmRewardLog"("userId", "createdAt" DESC);
CREATE INDEX "AzmRewardLog_source_idx" ON "AzmRewardLog"("source");
CREATE INDEX "AzmRewardLog_userId_source_idx" ON "AzmRewardLog"("userId", "source");

-- 4. Foreign key
ALTER TABLE "AzmRewardLog" ADD CONSTRAINT "AzmRewardLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
