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

const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');
const { SUPPORTED_CURRENCIES } = require('./multiCurrencyController');
const {
    Decimal,
    quantizeFor,
    toWireString,
    parseUserAmount,
} = require('../services/settlementScale');

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
  // SETTLEMENT SCALE: the persisted FxRate row is already a Prisma.Decimal
  // (column Decimal(20, 8)) — the exact observation. The previous
  // parseFloat(row.toString()) round-trip demoted it to a JS double and
  // the money math then re-parsed that lossy representation. Conversions
  // use the exact Decimal; finiteness/positivity are checked with Decimal
  // arithmetic, not Number.isFinite.
  const rate = new Decimal(row.rate.toString());
  if (!rate.isFinite() || rate.lte(0)) {
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

    // SETTLEMENT SCALE (Blocker B): the per-cycle contribution is a real
    // money amount persisted to a Decimal(20, 8) column. Parse it through
    // the settlement authority BEFORE the group is created — refuses
    // zero/negative/non-numeric input and precision beyond the base
    // currency's settlement scale instead of silently rounding a
    // parseFloat into the ledger.
    const contributionParse = parseUserAmount(contributionAmount, baseCurr);
    if (!contributionParse.ok) {
      return res.status(400).json({
        success: false,
        code: contributionParse.code,
        message: contributionParse.code === 'AMOUNT_PRECISION_EXCEEDED'
          ? `Contribution amount exceeds ${baseCurr} settlement precision.`
          : 'Invalid contribution amount.',
      });
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
        // Validated + settled above (contributionParse) — the exact
        // Decimal, never a parseFloat of the raw request.
        contributionUsdc: contributionParse.amount, // base currency amount
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

    // AMOUNT VALIDATION (review fix): the old truthiness check accepted
    // zero and NEGATIVE amounts — a negative contribution CREDITS the
    // wallet and produces a negative "pool" entry. Amounts are parsed
    // ONCE into an exact Prisma.Decimal here, validated strictly
    // (finite, > 0), and every downstream calculation and DB write uses
    // that Decimal — no float arithmetic anywhere on the money path.
    // SETTLEMENT SCALE (Blocker B): user-supplied amounts are NEVER
    // silently rounded. The old path accepted any Decimal — including
    // sub-minor-unit precision ("10.000000001" GHS) that the wallet debit
    // and the Decimal(20, 8) snapshot could not both represent. The
    // request must settle exactly at the local currency's scale or be
    // refused with an explicit AMOUNT_PRECISION_EXCEEDED.
    const localParse = parseUserAmount(localAmount, localCurr);
    if (!localParse.ok) {
      return res.status(400).json({
        success: false,
        code: localParse.code,
        message: localParse.code === 'AMOUNT_PRECISION_EXCEEDED'
          ? `Amount exceeds ${localCurr} settlement precision.`
          : 'Invalid amount.',
      });
    }
    const localAmountDec = localParse.amount;

    // Get cross-border config
    const config = await prisma.crossBorderSusuConfig.findUnique({
      where: { susuGroupId },
    });

    if (!config) {
      return res.status(400).json({ success: false, message: 'Not a cross-border Susu group.' });
    }

    // CURRENCY-CONTRACT BOUNDARY (review closeout): as on the payout leg —
    // config.baseCurrency is DB-origin; re-check the supported-currency
    // contract before any settlementScale helper touches money.
    if (!SUPPORTED_CURRENCIES.includes(config.baseCurrency)) {
      return res.status(400).json({ success: false, code: 'UNSUPPORTED_BASE_CURRENCY', message: `Unsupported base currency on this group's config: ${config.baseCurrency}` });
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

    // Apply cross-border fee — EXACT DECIMAL ARITHMETIC, settled at the
    // boundary (Blocker B): the full-precision conversion product is
    // quantized ONCE to the base currency's settlement scale with the
    // policy rounding (ROUND_HALF_UP). The SETTLED values — not the
    // full-precision intermediates — are what the contribution record,
    // the FX snapshot, and the response all carry, so the persisted row,
    // the wallet math and the client see THE SAME number. (Previously the
    // unquantized product was persisted and PostgreSQL silently rounded
    // the Decimal(20, 8) column on insert — the response then serialized
    // the pre-rounding value the database never stored.)
    //
    // The effective rate is itself settled to the snapshot column's scale
    // (Decimal(18, 8)) BEFORE the multiplication, so the persisted
    // snapshot rate is bit-for-bit the rate actually applied.
    const effectiveRate = quantizeFor(
      new Decimal(String(fxRate)).mul(new Decimal(1).minus(new Decimal(String(CROSS_BORDER_FEE)))),
      'USDC' // rate columns settle at the base scale
    );
    const baseAmount = quantizeFor(localAmountDec.mul(effectiveRate), config.baseCurrency);
    const feeAmount = quantizeFor(
      localAmountDec.mul(new Decimal(String(CROSS_BORDER_FEE))),
      localCurr
    );

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
        where: { id: wallet.id, balance: { gte: localAmountDec } },
        data: { balance: { decrement: localAmountDec } },
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
          amountUsdc: baseAmount, // stored in base currency (exact Decimal)
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
          localAmount: localAmountDec,
          baseAmount,
          rate: effectiveRate,
          fee: feeAmount,
        },
      });

      return { contribution, baseAmount, feeAmount };
    });

    return res.json({
      success: true,
      message: `Contributed ${localAmount} ${localCurr} (= ${result.baseAmount.toFixed(2)} ${config.baseCurrency}).`,
      contribution: result.contribution,
      fxSnapshot: {
        from: localCurr,
        to: config.baseCurrency,
        // exact wire representation — the SETTLED values, fixed notation,
        // bit-for-bit what was persisted (never scientific notation, never
        // a pre-rounding intermediate)
        localAmount: toWireString(localAmountDec, localCurr),
        baseAmount: toWireString(result.baseAmount, config.baseCurrency),
        rate: toWireString(effectiveRate, 'USDC'),
        fee: toWireString(result.feeAmount, localCurr),
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

    // CURRENCY-CONTRACT BOUNDARY (review closeout): config.baseCurrency is
    // DB-origin, not request-origin — the request boundary validated it at
    // creation, but settlementScaleFor() itself DEFAULTS unknown/absent
    // currencies to fiat precision; the helper does not reject them. A
    // legacy/malformed config row must not silently settle at an
    // unvalidated scale, so the supported-currency contract is re-checked
    // HERE, before any money moves.
    if (!SUPPORTED_CURRENCIES.includes(config.baseCurrency)) {
      return res.status(400).json({ success: false, code: 'UNSUPPORTED_BASE_CURRENCY', message: `Unsupported base currency on this group's config: ${config.baseCurrency}` });
    }

    // Convert payout from base → target currency. The payout leg is a NEW
    // FX conversion authorized at payout time (the target currency and the
    // conversion rate are chosen NOW — there is no persisted pre-authorized
    // quote for this leg). It therefore requires a fresh, persisted,
    // non-demo observation of the payout pair: the display utility
    // getFxRate (with its hardcoded BASE_RATES fallback) is never used for
    // money movement.
    const basePayout = new Prisma.Decimal(cycle.payoutAmount.toString());
    let freshRate;
    try {
      freshRate = await getFreshCrossBorderRate(config.baseCurrency, targetCurr);
    } catch (err) {
      return res.status(503).json({ success: false, code: err.code || 'RATE_UNAVAILABLE', message: err.message || 'FX rate unavailable.', retryable: true });
    }
    const fxRate = freshRate.rate;

    // No fee on payout (fee was collected at contribution time).
    //
    // SETTLEMENT SCALE (Blocker B): the payout conversion is quantized
    // ONCE to the TARGET currency's settlement scale with the policy
    // rounding — the same settled Decimal is then what the wallet credit
    // increments, the FX snapshot persists and the response serializes.
    // The unquantized product previously diverged from the persisted
    // Decimal(20, 8) row PostgreSQL silently rounded.
    const targetAmount = quantizeFor(
      basePayout.mul(new Decimal(String(fxRate))),
      targetCurr
    );

    // Resolve the target wallet for the 404 verdict; the wallet is created
    // inside the transaction.
    const wallet = await prisma.currencyWallet.findUnique({
      where: { userId_currency: { userId, currency: targetCurr } },
    });

    const result = await prisma.$transaction(async (tx) => {
      // SINGLE-WINNER payout transition, ATOMIC with the credit, over an
      // EXPLICIT eligible set (review fix): only a cycle actively
      // COLLECTING (or in its grace window) may be paid out. The previous
      // `status: { not: 'PAID_OUT' }` predicate would also pay out PENDING
      // cycles (never started) and DEFAULTED cycles (already resolved by
      // the penalty ladder) — an inventory hole, not an eligibility
      // contract. A replayed or concurrent request finds zero updated
      // rows and is refused BEFORE any wallet credit.
      const transition = await tx.susuCycle.updateMany({
        where: { id: cycleId, status: { in: ['COLLECTING', 'COLLECTING_GRACE'] } },
        data: { status: 'PAID_OUT', paidOutAt: new Date() },
      });
      if (transition.count !== 1) {
        const current = await tx.susuCycle.findUnique({
          where: { id: cycleId },
          select: { status: true },
        });
        const err = new Error(
          current?.status === 'PAID_OUT'
            ? 'This cycle has already been paid out.'
            : 'This cycle is not eligible for payout.'
        );
        err.code = current?.status === 'PAID_OUT' ? 'PAYOUT_ALREADY_COMPLETED' : 'CYCLE_NOT_PAYOUT_ELIGIBLE';
        throw err;
      }

      // FUNDING PROOF (review fix): the payout is only as real as the
      // contributions backing it. The eligibility claim above won the
      // row; the PAID contributions of THIS cycle must now cover the
      // payout amount exactly-or-better. An unfunded (or
      // partially-funded) cycle is refused with an honest CYCLE_NOT_FUNDED
      // and NO wallet credit — the claim rolls back with the whole
      // transaction — instead of fabricating money from a
      // scheduler-assigned payoutAmount with no pool behind it.
      const funded = await tx.susuContribution.aggregate({
        where: { cycleId, status: 'PAID' },
        _sum: { amountUsdc: true },
      });
      const poolSum = new Prisma.Decimal(funded._sum.amountUsdc == null ? '0' : String(funded._sum.amountUsdc));
      const payoutAmt = new Prisma.Decimal(cycle.payoutAmount.toString());
      if (poolSum.lt(payoutAmt)) {
        const err = new Error('Cycle pool is not fully funded yet.');
        err.code = 'CYCLE_NOT_FUNDED';
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

      // Record payout FX snapshot — the SETTLED targetAmount (same value
      // credited above) and the rate column's own scale (Decimal(18, 8)).
      await tx.crossBorderFxSnapshot.create({
        data: {
          susuGroupId: cycle.susuGroupId,
          cycleId,
          userId,
          fromCurrency: config.baseCurrency,
          toCurrency: targetCurr,
          localAmount: basePayout,
          baseAmount: targetAmount,
          rate: quantizeFor(new Decimal(String(fxRate)), 'USDC'),
          fee: 0, // no fee on payout
        },
      });


      return { targetAmount };
    });

    return res.json({
      success: true,
      message: `Payout: ${basePayout.toFixed(2)} ${config.baseCurrency} → ${result.targetAmount.toFixed(2)} ${targetCurr}.`,
      payout: {
        // exact wire representation — the SETTLED values, fixed notation,
        // bit-for-bit what was persisted and credited
        baseAmount: toWireString(basePayout, config.baseCurrency),
        baseCurrency: config.baseCurrency,
        targetAmount: toWireString(result.targetAmount, targetCurr),
        targetCurrency: targetCurr,
        rate: String(fxRate),
      },
    });
  } catch (err) {
    if (err?.code === 'PAYOUT_ALREADY_COMPLETED') {
      return res.status(409).json({ success: false, code: 'PAYOUT_ALREADY_COMPLETED', message: err.message });
    }
    if (err?.code === 'CYCLE_NOT_PAYOUT_ELIGIBLE') {
      return res.status(409).json({ success: false, code: 'CYCLE_NOT_PAYOUT_ELIGIBLE', message: err.message });
    }
    if (err?.code === 'CYCLE_NOT_FUNDED') {
      return res.status(409).json({ success: false, code: 'CYCLE_NOT_FUNDED', message: err.message });
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
