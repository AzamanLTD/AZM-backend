-- =============================================================================
-- Migration: Savings System
-- Adds SavingsGoal and SavingsDeposit models for the savings/lock feature
-- =============================================================================

-- Savings Goal: defines a user's savings target with schedule
CREATE TABLE IF NOT EXISTS "SavingsGoal" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Savings',
    "targetAmountGhs" DOUBLE PRECISION NOT NULL,
    "currentAmountGhs" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "frequencyAmount" DOUBLE PRECISION NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'WEEKLY',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "nextDueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "streakCount" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "totalDeposits" INTEGER NOT NULL DEFAULT 0,
    "isLocked" BOOLEAN NOT NULL DEFAULT true,
    "earlyWithdrawalPenalty" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- Savings Deposit: individual deposits into a savings goal
CREATE TABLE IF NOT EXISTS "SavingsDeposit" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "goalId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountGhs" DOUBLE PRECISION NOT NULL,
    "amountUsdc" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavingsDeposit_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "SavingsGoal_userId_idx" ON "SavingsGoal"("userId");
CREATE INDEX IF NOT EXISTS "SavingsGoal_status_idx" ON "SavingsGoal"("status");
CREATE INDEX IF NOT EXISTS "SavingsGoal_nextDueDate_idx" ON "SavingsGoal"("nextDueDate");
CREATE INDEX IF NOT EXISTS "SavingsDeposit_goalId_idx" ON "SavingsDeposit"("goalId");
CREATE INDEX IF NOT EXISTS "SavingsDeposit_userId_idx" ON "SavingsDeposit"("userId");

-- Foreign keys
ALTER TABLE "SavingsGoal" ADD CONSTRAINT "SavingsGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavingsDeposit" ADD CONSTRAINT "SavingsDeposit_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavingsDeposit" ADD CONSTRAINT "SavingsDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
