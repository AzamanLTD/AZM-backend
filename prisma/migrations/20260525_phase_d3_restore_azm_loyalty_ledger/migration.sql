-- Phase D-3: Restore azmBalance as independent loyalty-point ledger
-- =============================================================================
-- Phase D-2 incorrectly dropped azmBalance, treating AZM as a derived UI label.
-- AZM is actually an independent platform reward point (loyalty currency) that
-- users earn and spend separately from their USDC cash balance.
--
-- This migration:
--   1. Re-adds the azmBalance column with DEFAULT 0.0
--   2. Re-adds the CHECK constraint (balance >= 0)
--
-- Note: Users whose azmBalance was previously converted to availableBalance
-- (by D-2's migration) will start fresh at 0.0. Their converted USDC remains
-- in availableBalance. The loyalty ledger starts clean from this point forward.
-- =============================================================================

-- Step 1: Re-add the azmBalance column
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "azmBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- Step 2: Re-add the CHECK constraint
ALTER TABLE "User" ADD CONSTRAINT "User_azmBalance_gte_zero" CHECK ("azmBalance" >= 0);
