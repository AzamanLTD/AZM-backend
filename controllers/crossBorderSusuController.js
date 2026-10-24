// controllers/crossBorderSusuController.js
// =============================================================================
// AZAMAN V3 — Cross-Border Susu (Phase 5)
//
// Extends the Susu system to support members from different countries.
// Members contribute in their local currency; the pool is auto-converted
// to a base currency (group creator's choice). Payouts are converted back
// to the recipient's preferred currency at the prevailing FX rate.
//
// Key features:
// - Multi-country group creation with base currency selection
// - Per-member contribution in local currency (auto-converted to base)
// - Payout converted to recipient's preferred currency
// - FX rate locked at contribution time (protects from rate volatility)
// - Cross-border fee: 0.5% (lower than standard conversion since pool volume)
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');
const { SUPPORTED_CURRENCIES } = require('./multiCurrencyController');

const CROSS_BORDER_FEE = 0.005; // 0.5% fee on cross-border conversions
const MAX_COUNTRIES_PER_GROUP = 5;

// Authorization-grade rate authority for cross-border money movement.
//
// `getFxRate` (multiCurrencyController) is a DISPLAY/utility lookup: it
// silently falls back to hardcoded BASE_RATES when the FxRate table row is
// missing — a fabricated demo rate. That is never acceptable for money
// movement. Money paths here must read the persisted FxRate observation
// and fail closed when it is missing, non-positive or stale, mirroring the
// canonical 271C freshness discipline (default 30-minute observation age).
const RATE_OBSERVATION_MAX_AGE_MS = 30 * 60 * 1000;

async function getFreshCrossBorderRate(from, to) {
  const row = await prisma.fxRate.findUnique({
    where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
  });
  if (!row) {
    const err = new Error('FX rate unavailable.');
    err.code = 'RATE_UNAVAILABLE';
    throw err;
  }
  const rate = parseFloat(row.rate.toString());
  if (!Number.isFinite(rate) || rate <= 0) {
    const err = new Error('FX rate unavailable.');
    err.code = 'RATE_UNAVAILABLE';
    throw err;
  }
  const ageMs = Date.now() - row.fetchedAt.getTime();
  if (ageMs > RATE_OBSERVATION_MAX_AGE_MS) {
    const err = new Error('FX rate stale.');
    err.code = 'RATE_STALE';
    throw err;
  }
  // Future observations beyond a small clock-skew allowance are untrustworthy.
  if (ageMs < -60 * 1000) {
    const err = new Error('FX rate stale.');
    err.code = 'RATE_STALE';
    throw err;
  }
  return { rate, observedAt: row.fetchedAt };
}

// ── Create cross-border Susu group ──────────────────────────────────────────
async function createCrossBorderSusu(req, res) {
  try {
    const userId = req.user.id;
    const {
      name, description, contributionAmount, baseCurrency,
      frequency, totalCycles, memberCountries,
    } = req.body;

    if (!name || !contributionAmount || !baseCurrency || !frequency || !totalCycles) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const baseCurr = baseCurrency.toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(baseCurr)) {
      return res.status(400).json({ success: false, message: 'Unsupported base currency.' });
    }

    if (!memberCountries || memberCountries.length < 2) {
      return res.status(400).json({ success: false, message: 'Cross-border Susu requires members from at least 2 countries.' });
    }

    if (memberCountries.length > MAX_COUNTRIES_PER_GROUP) {
      return res.status(400).json({ success: false, message: `Maximum ${MAX_COUNTRIES_PER_GROUP} countries per group.` });
    }

    // Validate all member currencies are supported
    for (const c of memberCountries) {
      if (!SUPPORTED_CURRENCIES.includes(c.currency?.toUpperCase())) {
        return res.status(400).json({ success: false, message: `Unsupported member currency: ${c.currency}` });
      }
    }

    // Create the Susu group with cross-border metadata
    const susuGroup = await prisma.susuGroup.create({
      data: {
        status: 'CONFIGURING',
        contributionUsdc: parseFloat(contributionAmount), // base currency amount
        frequency: frequency.toUpperCase(),
        totalCycles: parseInt(totalCycles),
        startDate: new Date(req.body.startDate || Date.now() + 24 * 60 * 60 * 1000),
        rotationSnapshot: [],
        // Store cross-border config in a separate table
      },
    });

    // Create cross-border config
    const crossBorderConfig = await prisma.crossBorderSusuConfig.create({
      data: {
        susuGroupId: susuGroup.id,
        baseCurrency: baseCurr,
        memberCountries: memberCountries,
        crossBorderFee: CROSS_BORDER_FEE,
        createdBy: userId,
      },
    });

    return res.json({
      success: true,
      susuGroup,
      crossBorderConfig,
      message: `Cross-border Susu created with base currency ${baseCurr}. Members from ${memberCountries.length} countries.`,
    });
  } catch (err) {
    logger.error({ err }, '[crossBorderSusu] create error');
    return res.status(500).json({ success: false, message: 'Failed to create cross-border Susu.' });
  }
}

// ── Contribute in local currency ─────────────────────────────────────────────
async function contributeLocalCurrency(req, res) {
  try {
    const userId = req.user.id;
    const { susuGroupId, cycleId, localAmount, localCurrency } = req.body;

    if (!susuGroupId || !cycleId || !localAmount || !localCurrency) {
      return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    const localCurr = localCurrency.toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(localCurr)) {
      return res.status(400).json({ success: false, message: 'Unsupported currency.' });
    }

    // Get cross-border config
    const config = await prisma.crossBorderSusuConfig.findUnique({
      where: { susuGroupId },
    });

    if (!config) {
      return res.status(400).json({ success: false, message: 'Not a cross-border Susu group.' });
    }

    // Get FX rate from local → base (authorization-grade: no demo
    // fallback, freshness-checked observation — see getFreshCrossBorderRate)
    let freshRate;
    try {
      freshRate = await getFreshCrossBorderRate(localCurr, config.baseCurrency);
    } catch (err) {
      return res.status(503).json({ success: false, code: err.code || 'RATE_UNAVAILABLE', message: err.message || 'FX rate unavailable.', retryable: true });
    }
    const fxRate = freshRate.rate;

    // Apply cross-border fee
    const effectiveRate = fxRate * (1 - CROSS_BORDER_FEE);
    const baseAmount = parseFloat(localAmount) * effectiveRate;

    // Resolve the wallet for the 404 verdict; the balance CHECK happens
    // inside the transaction as a conditional debit so two concurrent
    // contributions can never spend the same stale balance twice.
    const wallet = await prisma.currencyWallet.findUnique({
      where: { userId_currency: { userId, currency: localCurr } },
    });
    if (!wallet) {
      return res.status(404).json({ success: false, message: `${localCurr} wallet not found.` });
    }

    // Record the contribution with FX metadata
    const result = await prisma.$transaction(async (tx) => {
      // Debit local wallet — SINGLE-WINNER conditional update: a wallet
      // whose live balance is below the amount is not debited at all.
      const debited = await tx.currencyWallet.updateMany({
        where: { id: wallet.id, balance: { gte: parseFloat(localAmount) } },
        data: { balance: { decrement: parseFloat(localAmount) } },
      });
      if (debited.count !== 1) {
        const err = new Error(`Insufficient ${localCurr} balance.`);
        err.code = 'INSUFFICIENT_BALANCE';
        throw err;
      }

      // Create contribution record with FX snapshot
      const contribution = await tx.susuContribution.create({
        data: {
          cycleId,
          memberId: req.body.memberId,
          userId,
          amountUsdc: baseAmount, // stored in base currency
          status: 'PAID',
        },
      });

      // Record FX snapshot for audit
      await tx.crossBorderFxSnapshot.create({
        data: {
          susuGroupId,
          cycleId,
          userId,
          fromCurrency: localCurr,
          toCurrency: config.baseCurrency,
          localAmount: parseFloat(localAmount),
          baseAmount,
          rate: effectiveRate,
          fee: parseFloat(localAmount) * CROSS_BORDER_FEE,
        },
      });

      return { contribution, baseAmount };
    });

    return res.json({
      success: true,
      message: `Contributed ${localAmount} ${localCurr} (= ${result.baseAmount.toFixed(2)} ${config.baseCurrency}).`,
      contribution: result.contribution,
      fxSnapshot: {
        from: localCurr,
        to: config.baseCurrency,
        rate: effectiveRate,
        fee: parseFloat(localAmount) * CROSS_BORDER_FEE,
      },
    });
  } catch (err) {
    if (err?.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ success: false, message: err.message });
    }
    logger.error({ err }, '[crossBorderSusu] contribute error');
    return res.status(500).json({ success: false, message: 'Contribution failed.' });
  }
}

// ── Payout in recipient's preferred currency ────────────────────────────────
async function payoutLocalCurrency(req, res) {
  try {
    const { cycleId, targetCurrency } = req.body;
    const userId = req.user.id;

    const targetCurr = (targetCurrency || 'USD').toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(targetCurr)) {
      return res.status(400).json({ success: false, message: 'Unsupported target currency.' });
    }

    // Get cycle
    const cycle = await prisma.susuCycle.findUnique({
      where: { id: cycleId },
    });

    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found.' });
    if (cycle.payoutUserId !== userId) return res.status(403).json({ success: false, message: 'Not the payout recipient.' });

    // Get cross-border config
    const config = await prisma.crossBorderSusuConfig.findUnique({
      where: { susuGroupId: cycle.susuGroupId },
    });

    if (!config) {
      return res.status(400).json({ success: false, message: 'Not a cross-border Susu.' });
    }

    // Convert payout from base → target currency. The payout leg is a NEW
    // FX conversion authorized at payout time (the target currency and the
    // conversion rate are chosen NOW — there is no persisted pre-authorized
    // quote for this leg). It therefore requires a fresh, persisted,
    // non-demo observation of the payout pair: the display utility
    // getFxRate (with its hardcoded BASE_RATES fallback) is never used for
    // money movement.
    const basePayout = parseFloat(cycle.payoutAmount.toString());
    let freshRate;
    try {
      freshRate = await getFreshCrossBorderRate(config.baseCurrency, targetCurr);
    } catch (err) {
      return res.status(503).json({ success: false, code: err.code || 'RATE_UNAVAILABLE', message: err.message || 'FX rate unavailable.', retryable: true });
    }
    const fxRate = freshRate.rate;

    // No fee on payout (fee was collected at contribution time)
    const targetAmount = basePayout * fxRate;

    // Resolve the target wallet for the 404 verdict; the wallet is created
    // inside the transaction.
    const wallet = await prisma.currencyWallet.findUnique({
      where: { userId_currency: { userId, currency: targetCurr } },
    });

    const result = await prisma.$transaction(async (tx) => {
      // SINGLE-WINNER payout transition, FIRST inside the transaction and
      // ATOMIC with the credit: only a request that flips a not-yet-paid
      // cycle to PAID_OUT proceeds. A replayed or concurrent request finds
      // zero updated rows and is refused BEFORE any wallet credit — the
      // same cycle can never be paid out twice.
      const transition = await tx.susuCycle.updateMany({
        where: { id: cycleId, status: { not: 'PAID_OUT' } },
        data: { status: 'PAID_OUT', paidOutAt: new Date() },
      });
      if (transition.count !== 1) {
        const err = new Error('This cycle has already been paid out.');
        err.code = 'PAYOUT_ALREADY_COMPLETED';
        throw err;
      }

      let targetWallet = wallet;
      if (!targetWallet) {
        targetWallet = await tx.currencyWallet.create({
          data: { userId, currency: targetCurr, balance: 0 },
        });
      }

      await tx.currencyWallet.update({
        where: { id: targetWallet.id },
        data: { balance: { increment: targetAmount } },
      });

      // Record payout FX snapshot
      await tx.crossBorderFxSnapshot.create({
        data: {
          susuGroupId: cycle.susuGroupId,
          cycleId,
          userId,
          fromCurrency: config.baseCurrency,
          toCurrency: targetCurr,
          localAmount: basePayout,
          baseAmount: targetAmount,
          rate: fxRate,
          fee: 0, // no fee on payout
        },
      });


      return { targetAmount };
    });

    return res.json({
      success: true,
      message: `Payout: ${basePayout.toFixed(2)} ${config.baseCurrency} → ${result.targetAmount.toFixed(2)} ${targetCurr}.`,
      payout: {
        baseAmount: basePayout,
        baseCurrency: config.baseCurrency,
        targetAmount: parseFloat(result.targetAmount.toFixed(2)),
        targetCurrency: targetCurr,
        rate: fxRate,
      },
    });
  } catch (err) {
    if (err?.code === 'PAYOUT_ALREADY_COMPLETED') {
      return res.status(409).json({ success: false, code: 'PAYOUT_ALREADY_COMPLETED', message: err.message });
    }
    logger.error({ err }, '[crossBorderSusu] payout error');
    return res.status(500).json({ success: false, message: 'Payout failed.' });
  }
}

// ── Get cross-border Susu details ────────────────────────────────────────────
async function getCrossBorderDetails(req, res) {
  try {
    const { susuGroupId } = req.params;

    const config = await prisma.crossBorderSusuConfig.findUnique({
      where: { susuGroupId },
    });

    if (!config) {
      return res.status(404).json({ success: false, message: 'Not a cross-border Susu.' });
    }

    // Get FX snapshots for this group
    const fxSnapshots = await prisma.crossBorderFxSnapshot.findMany({
      where: { susuGroupId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return res.json({
      success: true,
      config,
      fxSnapshots,
    });
  } catch (err) {
    logger.error({ err }, '[crossBorderSusu] details error');
    return res.status(500).json({ success: false, message: 'Failed to load details.' });
  }
}

module.exports = {
  createCrossBorderSusu,
  contributeLocalCurrency,
  payoutLocalCurrency,
  getCrossBorderDetails,
  CROSS_BORDER_FEE,
};
