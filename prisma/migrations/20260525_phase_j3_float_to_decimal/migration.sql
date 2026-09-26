-- Phase J3: Float → Decimal Migration
-- =====================================================
-- Converts all DOUBLE PRECISION (Float) columns to DECIMAL/NUMERIC
-- with explicit precision and scale for financial accuracy.
--
-- Categories:
--   Decimal(20,8) — monetary amounts (USDT, USDC, GHS, AZM, volumes)
--   Decimal(18,8) — exchange rates (USD→GHS, crypto→USD)
--   Decimal(10,4) — percentages, margins, fee shares
--   Decimal(5,2)  — bounded percentages (0–100 range)
--
-- This is a non-destructive ALTER COLUMN TYPE operation. PostgreSQL
-- can cast DOUBLE PRECISION → NUMERIC without data loss (all existing
-- float64 values are representable in NUMERIC).
-- =====================================================

-- =========================================================================
-- USER MODEL
-- =========================================================================

ALTER TABLE "User"
  ALTER COLUMN "availableBalance" TYPE DECIMAL(20,8),
  ALTER COLUMN "vendorUnallocatedBalance" TYPE DECIMAL(20,8),
  ALTER COLUMN "escrowLockedBalance" TYPE DECIMAL(20,8),
  ALTER COLUMN "disputeEscrowBalance" TYPE DECIMAL(20,8),
  ALTER COLUMN "azmBalance" TYPE DECIMAL(20,8),
  ALTER COLUMN "completionRate" TYPE DECIMAL(5,2),
  ALTER COLUMN "activeDiscountCredit" TYPE DECIMAL(20,8),
  ALTER COLUMN "totalVolumeUsdc" TYPE DECIMAL(20,8),
  ALTER COLUMN "totalProfitUsdc" TYPE DECIMAL(20,8);

-- =========================================================================
-- AD MODEL
-- =========================================================================

ALTER TABLE "Ad"
  ALTER COLUMN "pricePerUSD" TYPE DECIMAL(18,8),
  ALTER COLUMN "margin" TYPE DECIMAL(10,4),
  ALTER COLUMN "baseMargin" TYPE DECIMAL(10,4),
  ALTER COLUMN "vendorMargin" TYPE DECIMAL(10,4),
  ALTER COLUMN "minLimit" TYPE DECIMAL(20,8),
  ALTER COLUMN "maxLimit" TYPE DECIMAL(20,8);

-- =========================================================================
-- TRADE MODEL
-- =========================================================================

ALTER TABLE "Trade"
  ALTER COLUMN "amountCrypto" TYPE DECIMAL(20,8),
  ALTER COLUMN "amountFiat" TYPE DECIMAL(20,8),
  ALTER COLUMN "rate" TYPE DECIMAL(18,8),
  ALTER COLUMN "adminBonusAmount" TYPE DECIMAL(20,8),
  ALTER COLUMN "vendorProfitCut" TYPE DECIMAL(20,8);

-- =========================================================================
-- WITHDRAWAL MODEL
-- =========================================================================

ALTER TABLE "Withdrawal"
  ALTER COLUMN "amount" TYPE DECIMAL(20,8),
  ALTER COLUMN "totalGasFee" TYPE DECIMAL(20,8),
  ALTER COLUMN "vendorGasShare" TYPE DECIMAL(20,8),
  ALTER COLUMN "adminGasShare" TYPE DECIMAL(20,8);

-- =========================================================================
-- GLOBAL SETTINGS
-- =========================================================================

ALTER TABLE "GlobalSettings"
  ALTER COLUMN "bankMargin" TYPE DECIMAL(10,4),
  ALTER COLUMN "thirdPartyMargin" TYPE DECIMAL(10,4),
  ALTER COLUMN "vendorShareUnder1k" TYPE DECIMAL(10,4),
  ALTER COLUMN "vendorShareOver1k" TYPE DECIMAL(10,4),
  ALTER COLUMN "gasFeeTrc20" TYPE DECIMAL(20,8),
  ALTER COLUMN "gasFeeErc20" TYPE DECIMAL(20,8),
  ALTER COLUMN "gasFeeBep20" TYPE DECIMAL(20,8),
  ALTER COLUMN "liveUsdToGhs" TYPE DECIMAL(18,8),
  ALTER COLUMN "liveUsdtToUsd" TYPE DECIMAL(18,8),
  ALTER COLUMN "liveUsdcToUsd" TYPE DECIMAL(18,8),
  ALTER COLUMN "liveDaiToUsd" TYPE DECIMAL(18,8),
  ALTER COLUMN "liveRetailRate" TYPE DECIMAL(18,8),
  ALTER COLUMN "liveCorporateRate" TYPE DECIMAL(18,8),
  ALTER COLUMN "p2pFeePct" TYPE DECIMAL(10,4);

-- =========================================================================
-- SYSTEM LIQUIDITY POOLS
-- =========================================================================

ALTER TABLE "SystemMasterCrypto"
  ALTER COLUMN "balance" TYPE DECIMAL(20,8);

ALTER TABLE "SystemHotWallet"
  ALTER COLUMN "balance" TYPE DECIMAL(20,8);

ALTER TABLE "SystemFiatPool"
  ALTER COLUMN "balance" TYPE DECIMAL(20,8);

ALTER TABLE "SystemProfitFees"
  ALTER COLUMN "balance" TYPE DECIMAL(20,8);

-- =========================================================================
-- TRANSACTION HISTORY & ADMIN PROFIT LOG
-- =========================================================================

ALTER TABLE "TransactionHistory"
  ALTER COLUMN "amountUsdc" TYPE DECIMAL(20,8),
  ALTER COLUMN "feeUsdc" TYPE DECIMAL(20,8);

ALTER TABLE "AdminProfitLog"
  ALTER COLUMN "amountUsdc" TYPE DECIMAL(20,8);

-- =========================================================================
-- GAMIFICATION
-- =========================================================================

ALTER TABLE "Badge"
  ALTER COLUMN "requiredVolume" TYPE DECIMAL(20,8);

ALTER TABLE "LeaderboardRecord"
  ALTER COLUMN "totalVolume" TYPE DECIMAL(20,8);

-- =========================================================================
-- ADMIN WAR ROOM & ANALYTICS
-- =========================================================================

ALTER TABLE "DailySnapshot"
  ALTER COLUMN "totalProfitUsdc" TYPE DECIMAL(20,8),
  ALTER COLUMN "totalVolumeUsdc" TYPE DECIMAL(20,8);

ALTER TABLE "ColdStorageLog"
  ALTER COLUMN "amountUsdc" TYPE DECIMAL(20,8);

ALTER TABLE "CorporatePurchaseLog"
  ALTER COLUMN "usdcAmount" TYPE DECIMAL(20,8),
  ALTER COLUMN "fiatSentTotal" TYPE DECIMAL(20,8),
  ALTER COLUMN "discountRate" TYPE DECIMAL(18,8),
  ALTER COLUMN "actualMarketRate" TYPE DECIMAL(18,8);

ALTER TABLE "ProfitWithdrawalLog"
  ALTER COLUMN "amountUsdc" TYPE DECIMAL(20,8);

-- =========================================================================
-- OPERATIONAL EXPENSE
-- =========================================================================

ALTER TABLE "OperationalExpense"
  ALTER COLUMN "costUsdc" TYPE DECIMAL(20,8);

-- =========================================================================
-- PEER TRANSFER
-- =========================================================================

ALTER TABLE "PeerTransfer"
  ALTER COLUMN "amount" TYPE DECIMAL(20,8);

-- =========================================================================
-- AZM REWARD & SPEND LOGS
-- =========================================================================

ALTER TABLE "AzmRewardLog"
  ALTER COLUMN "amount" TYPE DECIMAL(20,8),
  ALTER COLUMN "balanceAfter" TYPE DECIMAL(20,8);

ALTER TABLE "AzmSpendLog"
  ALTER COLUMN "amount" TYPE DECIMAL(20,8),
  ALTER COLUMN "balanceAfter" TYPE DECIMAL(20,8);

-- =========================================================================
-- SAVINGS SYSTEM
-- =========================================================================

ALTER TABLE "SavingsGoal"
  ALTER COLUMN "targetAmountGhs" TYPE DECIMAL(20,8),
  ALTER COLUMN "currentAmountGhs" TYPE DECIMAL(20,8),
  ALTER COLUMN "frequencyAmount" TYPE DECIMAL(20,8),
  ALTER COLUMN "earlyWithdrawalPenalty" TYPE DECIMAL(10,4);

ALTER TABLE "SavingsDeposit"
  ALTER COLUMN "amountGhs" TYPE DECIMAL(20,8),
  ALTER COLUMN "amountUsdc" TYPE DECIMAL(20,8);
