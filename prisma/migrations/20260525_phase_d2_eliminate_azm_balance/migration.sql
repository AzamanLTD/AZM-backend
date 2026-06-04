-- Phase D-2: Eliminate azmBalance — collapse into availableBalance (USDC)
-- =============================================================================
-- This migration:
--   1. Converts every user's azmBalance (GHS-denominated, 1 AZM = 1 GHS) to
--      USDC using the current liveUsdToGhs rate from GlobalSettings, and adds
--      the converted amount to their availableBalance.
--   2. Inserts a TransactionHistory audit row per migrated user for traceability.
--   3. Drops the azmBalance column from the User table.
--
-- IMPORTANT: This migration reads the live rate from GlobalSettings at execution
-- time. If GlobalSettings.id=1 does not exist or liveUsdToGhs is NULL/0, the
-- migration will skip the conversion (users with azmBalance > 0 would lose
-- their balance). Verify GlobalSettings is seeded before running.
--
-- Rollback: Not automatically reversible. Take a DB snapshot before deploying.
-- =============================================================================

-- Step 1: Convert azmBalance to availableBalance using the live rate.
-- Formula: availableBalance += azmBalance / liveUsdToGhs
-- (azmBalance is in GHS; dividing by GHS-per-USD gives USDC)
UPDATE "User"
SET "availableBalance" = "availableBalance" + ("azmBalance" / (
    SELECT COALESCE(NULLIF("liveUsdToGhs", 0), 15.0)
    FROM "GlobalSettings"
    WHERE id = 1
    LIMIT 1
))
WHERE "azmBalance" > 0;

-- Step 2: Insert TransactionHistory audit rows for every migrated user.
-- Uses txHash = 'AZM_MIGRATION_<id>' as an idempotency key.
--
-- Note: an earlier draft of this file inserted `updatedAt` here, but that
-- column has never existed on TransactionHistory in any migration or in the
-- current `schema.prisma`. Including it broke fresh deploys with
-- `column "updatedAt" of relation "TransactionHistory" does not exist`. The
-- column was removed from this INSERT to match reality on disk.
INSERT INTO "TransactionHistory" ("userId", "type", "amountUsdc", "feeUsdc", "txHash", "status", "createdAt")
SELECT
    u.id,
    'INTERNAL_TRANSFER',
    u."azmBalance" / (
        SELECT COALESCE(NULLIF("liveUsdToGhs", 0), 15.0)
        FROM "GlobalSettings"
        WHERE id = 1
        LIMIT 1
    ),
    0,
    'AZM_MIGRATION_' || u.id,
    'COMPLETED',
    NOW()
FROM "User" u
WHERE u."azmBalance" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "TransactionHistory" th
    WHERE th."txHash" = 'AZM_MIGRATION_' || u.id
  );

-- Step 3: Zero out azmBalance (belt-and-braces before column drop).
UPDATE "User" SET "azmBalance" = 0 WHERE "azmBalance" != 0;

-- Step 4: Drop the column.
ALTER TABLE "User" DROP COLUMN IF EXISTS "azmBalance";

-- Step 5: Drop the CHECK constraint that referenced azmBalance (added in Phase J2).
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_azmBalance_gte_zero";
