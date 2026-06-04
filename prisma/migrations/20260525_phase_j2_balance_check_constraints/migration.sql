-- =============================================================================
-- Phase J2 — Defensive CHECK constraints on balance / amount / rate columns
-- =============================================================================
--
-- The audit's §14 finding flagged two complaints about money columns:
--
--   1. They are stored as `Float` (PostgreSQL DOUBLE PRECISION). Floating
--      point arithmetic on currency causes rounding drift over time.
--      `runDoubleCheck`'s TOLERANCE = 0.000001 is essentially conceding
--      this drift. The proper fix is `Decimal(18,8)` everywhere — a
--      column-type rewrite that takes a heavy lock and changes the wire
--      format (Decimal serializes as a string in JSON; Float serializes
--      as a number). That is filed as Phase J3 and ships separately.
--
--   2. There is no DB-level guard against negative balances. Every
--      controller checks `if (user.availableBalance < amount)` before
--      subtracting, but if any controller misses the check (a future
--      regression, a code-review oversight, a worker that bypasses the
--      check), the row goes negative and `runDoubleCheck` does NOT
--      fire automatically — silent ledger corruption.
--
-- Phase J2 (this migration) addresses (2) by adding `CHECK (col >= 0)`
-- (or `> 0` / range constraints, where appropriate) at the database level
-- on every column that represents a balance, amount, fee, rate, ratio,
-- or limit. Postgres rejects any INSERT/UPDATE that would violate these
-- constraints — the controller bug surfaces as a Prisma exception at
-- transaction time instead of as a corrupt row at audit time.
--
-- This is pure additive defense-in-depth. No application code change is
-- required: every code path already enforces these conditions; the
-- constraints just close the gap in case a future edit forgets.
--
-- ── Constraint policy ────────────────────────────────────────────────────────
--
-- "balance / amount / fee / volume" columns get  `CHECK (col >= 0)`.
-- "price / rate / limit" columns get             `CHECK (col >  0)` because
--                                                zero would be nonsense.
-- "ratio / percentage [0..1]" columns get        `CHECK (col BETWEEN 0 AND 1)`.
-- "percentage [0..100]" columns get              `CHECK (col BETWEEN 0 AND 100)`.
--
-- Columns NOT constrained:
--   * `Ad.margin` (nullable Float?) — vendor-set markup percentage, default
--     null. Allowed to be 0 or positive in practice but the schema permits
--     null and the column is operator-driven, so we don't constrain.
--
-- ── Validation policy ────────────────────────────────────────────────────────
--
-- All constraints are added with full validation (no `NOT VALID` escape).
-- If any existing row violates a constraint, this migration WILL FAIL.
-- That is the desired outcome: a constraint failure surfaces ledger
-- corruption that should be repaired before Phase J3 (the column-type
-- rewrite) goes anywhere near the data.
--
-- Operator runbook in `docs/PHASE_J2_CHECK_CONSTRAINTS.md` covers the
-- failure-recovery flow (find the offending rows, decide repair-or-zero,
-- re-run). For an environment that wants to deploy first and audit later,
-- replace each `ADD CONSTRAINT` below with `ADD CONSTRAINT ... NOT VALID`
-- and run `ALTER TABLE ... VALIDATE CONSTRAINT ...` in a follow-up window.
--
-- ── Lock characteristics ─────────────────────────────────────────────────────
--
-- `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` takes an `ACCESS
-- EXCLUSIVE` lock briefly to register the constraint, then validates.
-- Validation does a single sequential scan per table (no row rewrite).
-- For the balance tables (`User` is the only one with serious row counts
-- for this app), the scan is O(rows) but doesn't block reads. Tables with
-- < 100k rows complete in seconds.
--
-- =============================================================================

-- ===== User: balance buckets + completion-rate percentage ====================
-- The four V2 USDC buckets, the AZM token bucket, the discount credit, and
-- the lifetime totals must never be negative. completionRate is a 0..100
-- percentage (verified via grep: vendorGamificationService updates it as
-- (positiveReviews / totalTrades) * 100 — capped naturally to that range).
ALTER TABLE "User"
  ADD CONSTRAINT "User_availableBalance_nonneg"         CHECK ("availableBalance"         >= 0),
  ADD CONSTRAINT "User_vendorUnallocatedBalance_nonneg" CHECK ("vendorUnallocatedBalance" >= 0),
  ADD CONSTRAINT "User_escrowLockedBalance_nonneg"      CHECK ("escrowLockedBalance"      >= 0),
  ADD CONSTRAINT "User_disputeEscrowBalance_nonneg"     CHECK ("disputeEscrowBalance"     >= 0),
  ADD CONSTRAINT "User_azmBalance_nonneg"               CHECK ("azmBalance"               >= 0),
  ADD CONSTRAINT "User_activeDiscountCredit_nonneg"     CHECK ("activeDiscountCredit"     >= 0),
  ADD CONSTRAINT "User_totalVolumeUsdc_nonneg"          CHECK ("totalVolumeUsdc"          >= 0),
  ADD CONSTRAINT "User_totalProfitUsdc_nonneg"          CHECK ("totalProfitUsdc"          >= 0),
  ADD CONSTRAINT "User_completionRate_pct"              CHECK ("completionRate" >= 0 AND "completionRate" <= 100);

-- ===== System wallets: master crypto, hot, fiat pool, profit fees ============
-- These are the four global treasury buckets per AZAMAN_MASTER_SOUL.md §1.
-- A negative system balance would mean the platform owes more than it holds.
ALTER TABLE "SystemMasterCrypto" ADD CONSTRAINT "SystemMasterCrypto_balance_nonneg" CHECK ("balance" >= 0);
ALTER TABLE "SystemHotWallet"    ADD CONSTRAINT "SystemHotWallet_balance_nonneg"    CHECK ("balance" >= 0);
ALTER TABLE "SystemFiatPool"     ADD CONSTRAINT "SystemFiatPool_balance_nonneg"     CHECK ("balance" >= 0);
ALTER TABLE "SystemProfitFees"   ADD CONSTRAINT "SystemProfitFees_balance_nonneg"   CHECK ("balance" >= 0);

-- ===== Ad: prices and limits must be positive; min <= max =====================
-- A zero price or zero limit makes no sense (free trades, no minimum,
-- no maximum). The min<=max invariant prevents minLimit > maxLimit ads
-- which would never match any trade.
ALTER TABLE "Ad"
  ADD CONSTRAINT "Ad_pricePerUSD_pos"     CHECK ("pricePerUSD" > 0),
  ADD CONSTRAINT "Ad_minLimit_pos"        CHECK ("minLimit"    > 0),
  ADD CONSTRAINT "Ad_maxLimit_pos"        CHECK ("maxLimit"    > 0),
  ADD CONSTRAINT "Ad_minMax_order"        CHECK ("minLimit" <= "maxLimit"),
  ADD CONSTRAINT "Ad_baseMargin_nonneg"   CHECK ("baseMargin"   >= 0),
  ADD CONSTRAINT "Ad_vendorMargin_nonneg" CHECK ("vendorMargin" >= 0);

-- ===== Trade: amount and rate must be non-negative ==========================
ALTER TABLE "Trade"
  ADD CONSTRAINT "Trade_amountCrypto_nonneg"     CHECK ("amountCrypto"     >= 0),
  ADD CONSTRAINT "Trade_amountFiat_nonneg"       CHECK ("amountFiat"       >= 0),
  ADD CONSTRAINT "Trade_rate_nonneg"             CHECK ("rate"             >= 0),
  ADD CONSTRAINT "Trade_adminBonusAmount_nonneg" CHECK ("adminBonusAmount" >= 0),
  ADD CONSTRAINT "Trade_vendorProfitCut_nonneg"  CHECK ("vendorProfitCut"  >= 0);

-- ===== Withdrawal: amount and gas shares non-negative =======================
ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_amount_nonneg"         CHECK ("amount"         >= 0),
  ADD CONSTRAINT "Withdrawal_totalGasFee_nonneg"    CHECK ("totalGasFee"    >= 0),
  ADD CONSTRAINT "Withdrawal_vendorGasShare_nonneg" CHECK ("vendorGasShare" >= 0),
  ADD CONSTRAINT "Withdrawal_adminGasShare_nonneg"  CHECK ("adminGasShare"  >= 0);

-- ===== GlobalSettings: rates, margins, ratios ===============================
-- Rates must be positive (zero would mean free conversion / divide-by-zero
-- in display math). Ratios must be in [0, 1] (the vendor profit share
-- split). Gas fees and margins are non-negative.
ALTER TABLE "GlobalSettings"
  ADD CONSTRAINT "GS_bankMargin_nonneg"        CHECK ("bankMargin"         >= 0),
  ADD CONSTRAINT "GS_thirdPartyMargin_nonneg"  CHECK ("thirdPartyMargin"   >= 0),
  ADD CONSTRAINT "GS_vendorShareUnder1k_pct"   CHECK ("vendorShareUnder1k" >= 0 AND "vendorShareUnder1k" <= 1),
  ADD CONSTRAINT "GS_vendorShareOver1k_pct"    CHECK ("vendorShareOver1k"  >= 0 AND "vendorShareOver1k"  <= 1),
  ADD CONSTRAINT "GS_gasFeeTrc20_nonneg"       CHECK ("gasFeeTrc20"        >= 0),
  ADD CONSTRAINT "GS_gasFeeErc20_nonneg"       CHECK ("gasFeeErc20"        >= 0),
  ADD CONSTRAINT "GS_gasFeeBep20_nonneg"       CHECK ("gasFeeBep20"        >= 0),
  ADD CONSTRAINT "GS_liveUsdToGhs_pos"         CHECK ("liveUsdToGhs"       >  0),
  ADD CONSTRAINT "GS_liveUsdtToUsd_pos"        CHECK ("liveUsdtToUsd"      >  0),
  ADD CONSTRAINT "GS_liveUsdcToUsd_pos"        CHECK ("liveUsdcToUsd"      >  0),
  ADD CONSTRAINT "GS_liveDaiToUsd_pos"         CHECK ("liveDaiToUsd"       >  0),
  ADD CONSTRAINT "GS_liveRetailRate_pos"       CHECK ("liveRetailRate"     >  0),
  ADD CONSTRAINT "GS_liveCorporateRate_pos"    CHECK ("liveCorporateRate"  >  0);

-- ===== TransactionHistory: amount and fee always >= 0 =======================
-- TransactionHistory uses `type` (TransactionType enum) to encode direction,
-- not the sign of `amountUsdc`. Verified by grep: every transactionHistory.create
-- callsite passes a positive number and sets type = DEPOSIT|WITHDRAWAL|
-- INTERNAL_TRANSFER|TRADE_COMPLETE|... — see controllers/peerTransferController.js
-- lines 156-176, controllers/depositController.js line 425, etc.
ALTER TABLE "TransactionHistory"
  ADD CONSTRAINT "TH_amountUsdc_nonneg" CHECK ("amountUsdc" >= 0),
  ADD CONSTRAINT "TH_feeUsdc_nonneg"    CHECK ("feeUsdc"    >= 0);

-- ===== Audit/operations log amounts =========================================
ALTER TABLE "AdminProfitLog"      ADD CONSTRAINT "APL_amountUsdc_nonneg"  CHECK ("amountUsdc" >= 0);
ALTER TABLE "ColdStorageLog"      ADD CONSTRAINT "CSL_amountUsdc_nonneg"  CHECK ("amountUsdc" >= 0);
ALTER TABLE "ProfitWithdrawalLog" ADD CONSTRAINT "PWL_amountUsdc_nonneg"  CHECK ("amountUsdc" >= 0);
ALTER TABLE "OperationalExpense"  ADD CONSTRAINT "OE_costUsdc_nonneg"     CHECK ("costUsdc"   >= 0);

-- ===== Corporate purchase log: amounts non-negative; rate positive ==========
ALTER TABLE "CorporatePurchaseLog"
  ADD CONSTRAINT "CPL_usdcAmount_nonneg"      CHECK ("usdcAmount"       >= 0),
  ADD CONSTRAINT "CPL_fiatSentTotal_nonneg"   CHECK ("fiatSentTotal"    >= 0),
  ADD CONSTRAINT "CPL_discountRate_pct"       CHECK ("discountRate"     >= 0 AND "discountRate" <= 1),
  ADD CONSTRAINT "CPL_actualMarketRate_pos"   CHECK ("actualMarketRate" >  0);

-- ===== Gamification: required volume / leaderboard volume / daily snapshot ==
ALTER TABLE "Badge"             ADD CONSTRAINT "Badge_requiredVolume_nonneg" CHECK ("requiredVolume" >= 0);
ALTER TABLE "LeaderboardRecord" ADD CONSTRAINT "LR_totalVolume_nonneg"       CHECK ("totalVolume"    >= 0);
ALTER TABLE "DailySnapshot"
  ADD CONSTRAINT "DS_totalProfitUsdc_nonneg" CHECK ("totalProfitUsdc" >= 0),
  ADD CONSTRAINT "DS_totalVolumeUsdc_nonneg" CHECK ("totalVolumeUsdc" >= 0);

-- ===== PeerTransfer (V2 friend-to-friend transfer) ==========================
ALTER TABLE "PeerTransfer" ADD CONSTRAINT "PT_amount_nonneg" CHECK ("amount" >= 0);

-- ===== Savings: targets and frequencies must be positive ====================
-- A goal with target = 0 makes no sense. currentAmountGhs accumulates and
-- can equal target on completion but should never be negative. The
-- earlyWithdrawalPenalty is a [0..1] ratio.
ALTER TABLE "SavingsGoal"
  ADD CONSTRAINT "SG_targetAmountGhs_pos"        CHECK ("targetAmountGhs"        >  0),
  ADD CONSTRAINT "SG_currentAmountGhs_nonneg"    CHECK ("currentAmountGhs"       >= 0),
  ADD CONSTRAINT "SG_frequencyAmount_pos"        CHECK ("frequencyAmount"        >  0),
  ADD CONSTRAINT "SG_earlyWithdrawalPenalty_pct" CHECK ("earlyWithdrawalPenalty" >= 0 AND "earlyWithdrawalPenalty" <= 1);

ALTER TABLE "SavingsDeposit"
  ADD CONSTRAINT "SD_amountGhs_nonneg"  CHECK ("amountGhs"  >= 0),
  ADD CONSTRAINT "SD_amountUsdc_nonneg" CHECK ("amountUsdc" >= 0);
