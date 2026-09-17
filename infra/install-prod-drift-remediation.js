#!/usr/bin/env node
// =============================================================================
// install-prod-drift-remediation.js — one-time schema-drift remediation installer
// =============================================================================
// Production is db-push managed and has NEVER had the Prisma migration chain,
// the release overlays, or the hand-written CHECK constraints applied. The
// deployed application code (main 75cf7e7) requires several of the missing
// objects at runtime:
//
//   - AzmRewardLog/AzmSpendLog "dedupKey" columns + unique indexes  (PR #254
//     DB idempotency gate; every dedup-supplying creditAzm/debitAzm call —
//     stake STAKE_LOCK/STAKE_RELEASE, conversion, auction settlement,
//     login-streak rewards, vault, susu, gift — fails closed today because
//     the column does not exist).
//   - TransactionType.OVERPAYMENT_FREEZE enum value (flagOverpayment can
//     never commit).
//   - BusinessProfile.stakeBalance (business stake flows).
//   - The BusinessOrderItem table (retail checkout line items).
//
// This installer closes the Prisma-model portion of the drift additively and
// idempotently (safe to re-run; belongs in the release chain). The overlay
// installers (transaction-quote, payout-reconciliation, phase3,
// retail-checkout-integrity) close the rest and are run separately.
//
// CHECK constraints (J2 + all later hand-written CHECKs, 76 total) are
// installed ADD CONSTRAINT ... NOT VALID, then VALIDATEd so existing rows are
// scanned without a long rewrite lock. A constraint whose validation finds
// historical violations stays NOT VALID: it still protects all NEW writes,
// and the offending rows are reported for a data-repair decision. This
// mirrors docs/PHASE_J2_CHECK_CONSTRAINTS.md guidance.
// =============================================================================

const { PrismaClient } = require('@prisma/client');

// Standalone client used only when this file is run as a CLI. When called
// from autoRelease.js (or any host with its own Prisma client), pass the
// caller's client as the `client` argument so the app's pooled connection
// is reused — avoids a second Neon connection (pooler/advisory-lock issues
// that plague one-off clients on Neon).
const prisma = new PrismaClient();

async function run(db, label, sql) {
  try {
    await db.$executeRawUnsafe(sql);
    console.log(`  ok: ${label}`);
    return true;
  } catch (err) {
    console.error(`  FAIL: ${label}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — Prisma-model objects required by deployed application code
// (mirrors prisma/migrations/20260915120000_azm_ledger_dedup_unique,
//  20260914150000_overpayment_freeze_enum,
//  20260914120000_business_stake_balance,
//  20260731020000_add_business_order_item)
// ---------------------------------------------------------------------------
async function stage1(db) {
  console.log('[stage 1] Prisma-model objects required by deployed code');
  let ok = true;

  ok &= await run(db, 'AzmRewardLog.dedupKey column',
    'ALTER TABLE "AzmRewardLog" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT');
  ok &= await run(db, 'AzmSpendLog.dedupKey column',
    'ALTER TABLE "AzmSpendLog" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT');

  // Backfill dedupKey from the legacy metadata location (first row per
  // identity wins; duplicates — none found in production — would stay NULL
  // and remain visible in metadata). Idempotent: WHERE r."dedupKey" IS NULL.
  ok &= await run(db, 'AzmRewardLog.dedupKey backfill',
    `WITH ranked AS (
       SELECT id, metadata->>'dedupKey' AS dk,
              ROW_NUMBER() OVER (
                PARTITION BY "userId", "source", metadata->>'dedupKey'
                ORDER BY "createdAt", id
              ) AS rn
       FROM "AzmRewardLog"
       WHERE metadata ? 'dedupKey' AND metadata->>'dedupKey' IS NOT NULL
     )
     UPDATE "AzmRewardLog" AS r
     SET "dedupKey" = ranked.dk
     FROM ranked
     WHERE r.id = ranked.id AND ranked.rn = 1 AND r."dedupKey" IS NULL`);
  ok &= await run(db, 'AzmSpendLog.dedupKey backfill',
    `WITH ranked AS (
       SELECT id, metadata->>'dedupKey' AS dk,
              ROW_NUMBER() OVER (
                PARTITION BY "userId", "source", metadata->>'dedupKey'
                ORDER BY "createdAt", id
              ) AS rn
       FROM "AzmSpendLog"
       WHERE metadata ? 'dedupKey' AND metadata->>'dedupKey' IS NOT NULL
     )
     UPDATE "AzmSpendLog" AS r
     SET "dedupKey" = ranked.dk
     FROM ranked
     WHERE r.id = ranked.id AND ranked.rn = 1 AND r."dedupKey" IS NULL`);

  ok &= await run(db, 'AzmRewardLog dedup unique index',
    'CREATE UNIQUE INDEX IF NOT EXISTS "AzmRewardLog_userId_source_dedupKey_key" ON "AzmRewardLog"("userId", "source", "dedupKey")');
  ok &= await run(db, 'AzmSpendLog dedup unique index',
    'CREATE UNIQUE INDEX IF NOT EXISTS "AzmSpendLog_userId_source_dedupKey_key" ON "AzmSpendLog"("userId", "source", "dedupKey")');

  ok &= await run(db, 'TransactionType.OVERPAYMENT_FREEZE enum value',
    'ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS \'OVERPAYMENT_FREEZE\'');

  ok &= await run(db, 'BusinessProfile.stakeBalance column',
    'ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "stakeBalance" DECIMAL(20,8) NOT NULL DEFAULT 0');

  ok &= await run(db, 'BusinessOrderItem table',
    `CREATE TABLE IF NOT EXISTS "BusinessOrderItem" (
       "id" TEXT NOT NULL,
       "orderId" TEXT NOT NULL,
       "productId" TEXT NOT NULL,
       "name" VARCHAR(200) NOT NULL,
       "unitPrice" DECIMAL(20,8) NOT NULL,
       "quantity" INTEGER NOT NULL DEFAULT 1,
       "notes" VARCHAR(500),
       "lineTotal" DECIMAL(20,8) NOT NULL,
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt" TIMESTAMP(3) NOT NULL,
       CONSTRAINT "BusinessOrderItem_pkey" PRIMARY KEY ("id")
     )`);
  ok &= await run(db, 'BusinessOrderItem.orderId index',
    'CREATE INDEX IF NOT EXISTS "BusinessOrderItem_orderId_idx" ON "BusinessOrderItem"("orderId")');
  ok &= await run(db, 'BusinessOrderItem.productId index',
    'CREATE INDEX IF NOT EXISTS "BusinessOrderItem_productId_idx" ON "BusinessOrderItem"("productId")');
  ok &= await run(db, 'BusinessOrderItem.orderId FK', `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessOrderItem_orderId_fkey') THEN
      ALTER TABLE "BusinessOrderItem"
        ADD CONSTRAINT "BusinessOrderItem_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "BusinessOrder"("id") ON DELETE CASCADE;
    END IF;
  END $$;`);
  ok &= await run(db, 'BusinessOrderItem.productId FK', `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BusinessOrderItem_productId_fkey') THEN
      ALTER TABLE "BusinessOrderItem"
        ADD CONSTRAINT "BusinessOrderItem_productId_fkey"
        FOREIGN KEY ("productId") REFERENCES "BusinessProduct"("id");
    END IF;
  END $$;`);

  // Gift economic atomicity (2026-09-17): AzmGift.dedupKey is the exactly-once
  // gift-row claim for idempotent gift sends. Production AzmGift is empty — no
  // backfill. Additive + idempotent; runs in the release chain before the new
  // gift code can execute.
  ok &= await run(db, 'AzmGift.dedupKey column',
    'ALTER TABLE "AzmGift" ADD COLUMN IF NOT EXISTS "dedupKey" TEXT');
  ok &= await run(db, 'AzmGift dedup unique index',
    'CREATE UNIQUE INDEX IF NOT EXISTS "AzmGift_dedupKey_key" ON "AzmGift"("dedupKey")');

  return !!ok;
}

// ---------------------------------------------------------------------------
// Stage 2 — hand-written CHECK constraints (J2 + later), NOT VALID + VALIDATE
// ---------------------------------------------------------------------------
const CHECK_CONSTRAINTS = [
  { table: "User", name: "User_availableBalance_nonneg", expr: `"availableBalance" >= 0` },
  { table: "User", name: "User_vendorUnallocatedBalance_nonneg", expr: `"vendorUnallocatedBalance" >= 0` },
  { table: "User", name: "User_escrowLockedBalance_nonneg", expr: `"escrowLockedBalance" >= 0` },
  { table: "User", name: "User_disputeEscrowBalance_nonneg", expr: `"disputeEscrowBalance" >= 0` },
  { table: "User", name: "User_azmBalance_nonneg", expr: `"azmBalance" >= 0` },
  { table: "User", name: "User_activeDiscountCredit_nonneg", expr: `"activeDiscountCredit" >= 0` },
  { table: "User", name: "User_totalVolumeUsdc_nonneg", expr: `"totalVolumeUsdc" >= 0` },
  { table: "User", name: "User_totalProfitUsdc_nonneg", expr: `"totalProfitUsdc" >= 0` },
  { table: "User", name: "User_completionRate_pct", expr: `"completionRate" >= 0 AND "completionRate" <= 100` },
  { table: "SystemMasterCrypto", name: "SystemMasterCrypto_balance_nonneg", expr: `"balance" >= 0` },
  { table: "SystemHotWallet", name: "SystemHotWallet_balance_nonneg", expr: `"balance" >= 0` },
  { table: "SystemFiatPool", name: "SystemFiatPool_balance_nonneg", expr: `"balance" >= 0` },
  { table: "SystemProfitFees", name: "SystemProfitFees_balance_nonneg", expr: `"balance" >= 0` },
  { table: "Ad", name: "Ad_pricePerUSD_pos", expr: `"pricePerUSD" > 0` },
  { table: "Ad", name: "Ad_minLimit_pos", expr: `"minLimit" > 0` },
  { table: "Ad", name: "Ad_maxLimit_pos", expr: `"maxLimit" > 0` },
  { table: "Ad", name: "Ad_minMax_order", expr: `"minLimit" <= "maxLimit"` },
  { table: "Ad", name: "Ad_baseMargin_nonneg", expr: `"baseMargin" >= 0` },
  { table: "Ad", name: "Ad_vendorMargin_nonneg", expr: `"vendorMargin" >= 0` },
  { table: "Trade", name: "Trade_amountCrypto_nonneg", expr: `"amountCrypto" >= 0` },
  { table: "Trade", name: "Trade_amountFiat_nonneg", expr: `"amountFiat" >= 0` },
  { table: "Trade", name: "Trade_rate_nonneg", expr: `"rate" >= 0` },
  { table: "Trade", name: "Trade_adminBonusAmount_nonneg", expr: `"adminBonusAmount" >= 0` },
  { table: "Trade", name: "Trade_vendorProfitCut_nonneg", expr: `"vendorProfitCut" >= 0` },
  { table: "Withdrawal", name: "Withdrawal_amount_nonneg", expr: `"amount" >= 0` },
  { table: "Withdrawal", name: "Withdrawal_totalGasFee_nonneg", expr: `"totalGasFee" >= 0` },
  { table: "Withdrawal", name: "Withdrawal_vendorGasShare_nonneg", expr: `"vendorGasShare" >= 0` },
  { table: "Withdrawal", name: "Withdrawal_adminGasShare_nonneg", expr: `"adminGasShare" >= 0` },
  { table: "GlobalSettings", name: "GS_bankMargin_nonneg", expr: `"bankMargin" >= 0` },
  { table: "GlobalSettings", name: "GS_thirdPartyMargin_nonneg", expr: `"thirdPartyMargin" >= 0` },
  { table: "GlobalSettings", name: "GS_vendorShareUnder1k_pct", expr: `"vendorShareUnder1k" >= 0 AND "vendorShareUnder1k" <= 1` },
  { table: "GlobalSettings", name: "GS_vendorShareOver1k_pct", expr: `"vendorShareOver1k" >= 0 AND "vendorShareOver1k" <= 1` },
  { table: "GlobalSettings", name: "GS_gasFeeTrc20_nonneg", expr: `"gasFeeTrc20" >= 0` },
  { table: "GlobalSettings", name: "GS_gasFeeErc20_nonneg", expr: `"gasFeeErc20" >= 0` },
  { table: "GlobalSettings", name: "GS_gasFeeBep20_nonneg", expr: `"gasFeeBep20" >= 0` },
  { table: "GlobalSettings", name: "GS_liveUsdToGhs_pos", expr: `"liveUsdToGhs" > 0` },
  { table: "GlobalSettings", name: "GS_liveUsdtToUsd_pos", expr: `"liveUsdtToUsd" > 0` },
  { table: "GlobalSettings", name: "GS_liveUsdcToUsd_pos", expr: `"liveUsdcToUsd" > 0` },
  { table: "GlobalSettings", name: "GS_liveDaiToUsd_pos", expr: `"liveDaiToUsd" > 0` },
  { table: "GlobalSettings", name: "GS_liveRetailRate_pos", expr: `"liveRetailRate" > 0` },
  { table: "GlobalSettings", name: "GS_liveCorporateRate_pos", expr: `"liveCorporateRate" > 0` },
  // NOTE: TransactionHistory.amountUsdc is deliberately SIGNED (debits are
  // negative, e.g. TICKET_ESCROW_FUND payer rows). A >= 0 CHECK here breaks
  // escrow funding/susu/invoice/refund flows — proven by the full battery
  // against the CHECK-armed rehearsal DB (16 failures, all TH_amountUsdc_nonneg).
  { table: "TransactionHistory", name: "TH_feeUsdc_nonneg", expr: `"feeUsdc" >= 0` },
  { table: "AdminProfitLog", name: "APL_amountUsdc_nonneg", expr: `"amountUsdc" >= 0` },
  { table: "ColdStorageLog", name: "CSL_amountUsdc_nonneg", expr: `"amountUsdc" >= 0` },
  { table: "ProfitWithdrawalLog", name: "PWL_amountUsdc_nonneg", expr: `"amountUsdc" >= 0` },
  { table: "OperationalExpense", name: "OE_costUsdc_nonneg", expr: `"costUsdc" >= 0` },
  { table: "CorporatePurchaseLog", name: "CPL_usdcAmount_nonneg", expr: `"usdcAmount" >= 0` },
  { table: "CorporatePurchaseLog", name: "CPL_fiatSentTotal_nonneg", expr: `"fiatSentTotal" >= 0` },
  { table: "CorporatePurchaseLog", name: "CPL_discountRate_pct", expr: `"discountRate" >= 0 AND "discountRate" <= 1` },
  { table: "CorporatePurchaseLog", name: "CPL_actualMarketRate_pos", expr: `"actualMarketRate" > 0` },
  { table: "Badge", name: "Badge_requiredVolume_nonneg", expr: `"requiredVolume" >= 0` },
  { table: "LeaderboardRecord", name: "LR_totalVolume_nonneg", expr: `"totalVolume" >= 0` },
  { table: "DailySnapshot", name: "DS_totalProfitUsdc_nonneg", expr: `"totalProfitUsdc" >= 0` },
  { table: "DailySnapshot", name: "DS_totalVolumeUsdc_nonneg", expr: `"totalVolumeUsdc" >= 0` },
  { table: "PeerTransfer", name: "PT_amount_nonneg", expr: `"amount" >= 0` },
  { table: "SavingsGoal", name: "SG_targetAmountGhs_pos", expr: `"targetAmountGhs" > 0` },
  { table: "SavingsGoal", name: "SG_currentAmountGhs_nonneg", expr: `"currentAmountGhs" >= 0` },
  { table: "SavingsGoal", name: "SG_frequencyAmount_pos", expr: `"frequencyAmount" > 0` },
  { table: "SavingsGoal", name: "SG_earlyWithdrawalPenalty_pct", expr: `"earlyWithdrawalPenalty" >= 0 AND "earlyWithdrawalPenalty" <= 1` },
  { table: "SavingsDeposit", name: "SD_amountGhs_nonneg", expr: `"amountGhs" >= 0` },
  { table: "SavingsDeposit", name: "SD_amountUsdc_nonneg", expr: `"amountUsdc" >= 0` },
  { table: "User", name: "User_azmBalance_gte_zero", expr: `"azmBalance" >= 0` },
  { table: "GlobalSettings", name: "GlobalSettings_p2pFeePct_range", expr: `"p2pFeePct" >= 0 AND "p2pFeePct" <= 1` },
  { table: "AdminFeeProfile", name: "AdminFeeProfile_platformFeePct_range", expr: `"platformFeePct" >= 0 AND "platformFeePct" <= 1` },
  { table: "AdminFeeProfile", name: "AdminFeeProfile_adminSplitPct_range", expr: `"adminSplitPct" >= 0 AND "adminSplitPct" <= 1` },
  { table: "AdminFeeProfile", name: "AdminFeeProfile_vendorSplitPct_range", expr: `"vendorSplitPct" >= 0 AND "vendorSplitPct" <= 1` },
  { table: "AdminFeeProfile", name: "AdminFeeProfile_exitFeePct_range", expr: `"exitFeePct" >= 0 AND "exitFeePct" <= 1` },
  { table: "AdminFeeProfile", name: "AdminFeeProfile_split_sum", expr: `"adminSplitPct" + "vendorSplitPct" BETWEEN 0.9999 AND 1.0001` },
  { table: "GlobalSettings", name: "GlobalSettings_autoPayoutThresholdUsdc_gte0", expr: `"autoPayoutThresholdUsdc" >= 0` },
  { table: "GlobalSettings", name: "GlobalSettings_autoPayoutMaxAmountUsdc_gte0", expr: `"autoPayoutMaxAmountUsdc" >= 0` },
  { table: "GlobalSettings", name: "GlobalSettings_autoPayoutIntervalMs_gte10000", expr: `"autoPayoutIntervalMs" >= 10000` },
  { table: "Vault", name: "Vault_currentAmountUsdc_check", expr: `"currentAmountUsdc" >= 0` },
  { table: "Vault", name: "Vault_targetAmountUsdc_check", expr: `"targetAmountUsdc" > 0` },
  { table: "SmartRoute", name: "SmartRoute_amount_check", expr: `"amountUsdc" > 0` },
  { table: "AzmAuctionBid", name: "AzmAuctionBid_bidAmount_check", expr: `"bidAmountAzm" > 0` }
];

async function stage2(db) {
  console.log('[stage 2] CHECK constraints (NOT VALID + VALIDATE)');
  let added = 0, alreadyThere = 0, failed = 0;
  const pendingValidation = [];

  for (const c of CHECK_CONSTRAINTS) {
    const exists = await db.$queryRawUnsafe(
      `SELECT 1 FROM pg_constraint WHERE conname = '${c.name}' AND connamespace = 'public'::regnamespace`
    );
    if (exists.length > 0) { alreadyThere++; continue; }
    const addedOk = await run(
      db,
      `${c.table}.${c.name}`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${c.name}') THEN
           ALTER TABLE "${c.table}" ADD CONSTRAINT "${c.name}" CHECK (${c.expr}) NOT VALID;
         END IF;
       END $$;`
    );
    if (!addedOk) { failed++; continue; }
    added++;

    // Validate existing rows; a violation leaves the constraint NOT VALID
    // (still enforced for all NEW writes) and surfaces the offending rows.
    try {
      const viol = await db.$queryRawUnsafe(
        `SELECT count(*)::int AS v FROM "${c.table}" WHERE (${c.expr}) IS NOT TRUE`
      );
      const n = Number(viol[0]?.v ?? 0);
      if (n > 0) {
        pendingValidation.push({ constraint: c.name, table: c.table, violations: n });
      } else {
        await db.$executeRawUnsafe(`ALTER TABLE "${c.table}" VALIDATE CONSTRAINT "${c.name}"`);
      }
    } catch (err) {
      pendingValidation.push({ constraint: c.name, table: c.table, error: err.message });
    }
  }

  console.log(`  added: ${added}, already present: ${alreadyThere}, failed: ${failed}, pending validation: ${pendingValidation.length}`);
  for (const p of pendingValidation) {
    console.warn(`  PENDING VALIDATION: ${p.constraint} on ${p.table} — ${p.violations ?? p.error}`);
    console.warn(`    (constraint IS enforced for new writes; historical rows need a data-repair decision)`);
  }
  return { ok: failed === 0, pendingValidation };
}

/**
 * Run the full drift-remediation (stage 1 + stage 2).
 * @param {import('@prisma/client').PrismaClient} [client] caller's client;
 *   omitted only when running standalone as a CLI (own client, own pool).
 * @returns {Promise<{ok: boolean, stage1: boolean, stage2: boolean, pendingValidation: Array}>}
 */
async function install(client) {
  const db = client || prisma;
  const s1 = await stage1(db);
  const s2 = await stage2(db);
  return {
    ok: s1 && s2.ok,
    stage1: s1,
    stage2: s2.ok,
    pendingValidation: s2.pendingValidation,
  };
}

module.exports = { installProdDriftRemediation: install };

// Allow running standalone: `node infra/install-prod-drift-remediation.js`
if (require.main === module) {
  install()
    .then(async (r) => {
      await prisma.$disconnect();
      if (!r.ok) {
        console.error('DRIFT REMEDIATION INCOMPLETE — see failures above.');
        process.exit(1);
      }
      console.log('Drift remediation complete.');
      process.exit(0);
    })
    .catch(async (e) => {
      console.error('Fatal:', e.message);
      await prisma.$disconnect();
      process.exit(1);
    });
}
