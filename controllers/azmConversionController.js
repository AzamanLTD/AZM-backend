// controllers/azmConversionController.js
// =============================================================================
// AZAMAN V3 — AZM-to-USDC Conversion (Phase 5)
//
// Users can convert AZM loyalty points to USDC at a platform-determined rate.
// The USDC comes from SystemProfitFees (platform's accumulated earnings).
// This creates real utility for AZM beyond cosmetic perks.
//
// Conversion mechanics:
//   - Dynamic rate based on platform profit pool health
//   - Daily conversion limit per user (prevents whale dumping)
//   - Sliding-scale bonus for long-term holders (account age > 90 days)
//   - Burns AZM on conversion (removes from circulating supply)
//   - Credits USDC to availableBalance
//
// Flow:
//   1. Validate user AZM balance + daily limit
//   2. Calculate USDC amount from current rate
//   3. Check SystemProfitFees has sufficient USDC
//   4. Debit AZM (AzmSpendService)
//   5. Credit USDC to user.availableBalance
//   6. Debit SystemProfitFees
//   7. Record TransactionHistory + AzmConversionLog
//   8. Socket emission for real-time balance update
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');
const { AzmSpendService, AZM_SPEND_SOURCES } = require('../services/azmSpendService');

const spendService = new AzmSpendService(prisma);

// ── Conversion parameters ───────────────────────────────────────────────────
const BASE_RATE = 0.001;       // 1 AZM = 0.001 USDC base rate
const DAILY_AZM_LIMIT = 5000;  // Max 5000 AZM convertible per day
const MIN_CONVERT = 10;        // Min 10 AZM per conversion
const HOLDER_BONUS_THRESHOLD_DAYS = 90;
const HOLDER_BONUS_MULTIPLIER = 1.15; // 15% bonus for holders > 90 days

// ── Get current conversion rate ─────────────────────────────────────────────
async function getConversionRate(userId) {
  // Dynamic rate: base rate × profit pool health factor
  const profitPool = await prisma.systemProfitFees.findFirst({ where: { id: 1 } });
  const poolBalance = parseFloat(profitPool?.balance?.toString() || '0');

  // Health factor: 1.0 when pool > $10k, scales down to 0.5 when pool is low
  const healthFactor = Math.max(0.5, Math.min(1.0, poolBalance / 10000));

  let rate = BASE_RATE * healthFactor;

  // Holder bonus
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    if (user) {
      const accountAgeDays = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (accountAgeDays >= HOLDER_BONUS_THRESHOLD_DAYS) {
        rate *= HOLDER_BONUS_MULTIPLIER;
      }
    }
  }

  return {
    rate: parseFloat(rate.toFixed(6)),
    baseRate: BASE_RATE,
    healthFactor: parseFloat(healthFactor.toFixed(4)),
    dailyLimit: DAILY_AZM_LIMIT,
    minConvert: MIN_CONVERT,
  };
}

// ── Get remaining daily quota ──────────────────────────────────────────────
async function getDailyQuotaRemaining(userId) {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentConversions = await prisma.azmConversionLog.aggregate({
    where: {
      userId,
      createdAt: { gte: twentyFourHoursAgo },
    },
    _sum: { azmAmount: true },
  });

  const convertedToday = parseFloat(recentConversions._sum?.azmAmount?.toString() || '0');
  return Math.max(0, DAILY_AZM_LIMIT - convertedToday);
}

// ── POST /api/azm-convert ───────────────────────────────────────────────────
async function convertAzmToUsdc(req, res) {
  try {
    const userId = req.user.id;
    const { azmAmount } = req.body;

    // Validation
    if (!azmAmount || parseFloat(azmAmount) < MIN_CONVERT) {
      return res.status(400).json({
        success: false,
        message: `Minimum conversion is ${MIN_CONVERT} AZM.`,
      });
    }

    const amount = parseFloat(azmAmount);

    // Check daily quota
    const quotaRemaining = await getDailyQuotaRemaining(userId);
    if (amount > quotaRemaining) {
      return res.status(400).json({
        success: false,
        message: `Daily limit exceeded. You can convert up to ${quotaRemaining.toFixed(2)} AZM more today.`,
        quotaRemaining,
      });
    }

    // Get conversion rate
    const rateInfo = await getConversionRate(userId);
    const usdcAmount = amount * rateInfo.rate;

    // Check profit pool has sufficient USDC
    const profitPool = await prisma.systemProfitFees.findFirst({ where: { id: 1 } });
    const poolBalance = parseFloat(profitPool?.balance?.toString() || '0');

    if (poolBalance < usdcAmount) {
      return res.status(503).json({
        success: false,
        message: 'Conversion pool temporarily insufficient. Please try again later.',
        poolAvailable: poolBalance.toFixed(2),
      });
    }

    // Execute conversion atomically.
    //
    // Authorization happens at the database boundary, not from pre-reads:
    //   - the user's AZM debit is a CONDITIONAL mutation gated on
    //     azmBalance >= amount; 0 affected rows means a concurrent request
    //     already spent the AZM (or the user cannot afford it) and NOTHING
    //     is written.
    //   - the SystemProfitFees debit is a CONDITIONAL mutation gated on
    //     balance >= usdcAmount; 0 affected rows is a pool shortage and the
    //     whole transaction (debit included) rolls back — the pool can never
    //     go negative and AZM is never burned for USDC that was not backed.
    // The pre-transaction balance checks above are fast-path UX only; the
    // conditional mutations below are the only authorization.
    const result = await prisma.$transaction(async (tx) => {
      // 1. Atomically debit AZM and credit USDC in ONE conditional mutation.
      //    A read-then-decrement here would let two concurrent conversions
      //    both pass the JS check and drive azmBalance negative.
      const debited = await tx.user.updateMany({
        where: { id: userId, azmBalance: { gte: amount } },
        data: {
          azmBalance: { decrement: amount },
          availableBalance: { increment: usdcAmount },
        },
      });

      if (debited.count === 0) {
        const exists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
        if (!exists) throw new Error('User not found.');
        throw new Error('Insufficient AZM balance.');
      }

      // 2. Debit SystemProfitFees under the same boundary gate.
      const drained = await tx.systemProfitFees.updateMany({
        where: { id: 1, balance: { gte: usdcAmount } },
        data: { balance: { decrement: usdcAmount } },
      });

      if (drained.count === 0) {
        // Typed error so the catch block preserves the existing 503 contract.
        const err = new Error('Conversion pool temporarily insufficient.');
        err.isPoolShortage = true;
        throw err;
      }

      // 3. Read the post-mutation state for evidence. This is NOT an
      //    authorization read — the conditional mutations above already
      //    committed the effect; these values are only what the logs
      //    (balanceAfter, newAzmBalance, newUsdcBalance) record.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { azmBalance: true, availableBalance: true },
      });
      const newAzmBalance = parseFloat(user.azmBalance.toString());
      const newUsdcBalance = parseFloat(user.availableBalance.toString());

      // 4. Conversion log — created first so its row id is the stable
      //    identity the spend-log dedup key below is derived from.
      const conversionLog = await tx.azmConversionLog.create({
        data: {
          userId,
          azmAmount: amount,
          usdcAmount,
          rate: rateInfo.rate,
          baseRate: rateInfo.baseRate,
          holderBonus: rateInfo.rate !== rateInfo.baseRate * rateInfo.healthFactor,
          newAzmBalance,
          newUsdcBalance,
        },
      });

      // 5. Record AZM spend log — authoritative, exactly-once via the
      //    (userId, source, dedupKey) DB uniqueness. A duplicate aborts the
      //    whole transaction, rolling the debit and credit back with it.
      const spendLog = await tx.azmSpendLog.create({
        data: {
          userId,
          amount,
          reason: `Converted ${amount} AZM to ${usdcAmount.toFixed(4)} USDC`,
          source: AZM_SPEND_SOURCES.AZM_CONVERSION || 'AZM_CONVERSION',
          metadata: { conversion: true, usdcAmount, rate: rateInfo.rate },
          balanceAfter: newAzmBalance,
          dedupKey: `azm_conversion_${conversionLog.id}`,
        },
      });

      // 6. Record transaction history
      await tx.transactionHistory.create({
        data: {
          userId,
          type: 'AZM_CONVERSION_TO_USDC',
          amountUsdc: usdcAmount,
          feeUsdc: 0,
          status: 'COMPLETED',
          metadata: {
            azmAmount: amount,
            rate: rateInfo.rate,
            conversionId: conversionLog.id,
          },
        },
      });

      return { conversionLog, newAzmBalance, newUsdcBalance, usdcAmount };
    });

    // Socket emission
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${userId}`).emit('azm_converted', {
        azmConverted: amount,
        usdcReceived: result.usdcAmount,
        rate: rateInfo.rate,
        newAzmBalance: result.newAzmBalance,
        newUsdcBalance: result.newUsdcBalance,
      });
    }

    return res.json({
      success: true,
      message: `Converted ${amount} AZM to ${result.usdcAmount.toFixed(4)} USDC.`,
      conversion: {
        azmAmount: amount,
        usdcAmount: parseFloat(result.usdcAmount.toFixed(8)),
        rate: rateInfo.rate,
        newAzmBalance: parseFloat(result.newAzmBalance.toFixed(8)),
        newUsdcBalance: parseFloat(result.newUsdcBalance.toFixed(8)),
      },
    });
  } catch (err) {
    logger.error({ err: err }, '[azmConvert] error');
    if (err.isPoolShortage) {
      // Rolled back — re-read the (unchanged) pool for the response contract.
      const pool = await prisma.systemProfitFees.findFirst({ where: { id: 1 } });
      const poolBalance = parseFloat(pool?.balance?.toString() || '0');
      return res.status(503).json({
        success: false,
        message: 'Conversion pool temporarily insufficient. Please try again later.',
        poolAvailable: poolBalance.toFixed(2),
      });
    }
    if (err.message.includes('Insufficient AZM')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Conversion failed.' });
  }
}

// ── GET /api/azm-convert/rate ────────────────────────────────────────────────
async function getRate(req, res) {
  try {
    const rateInfo = await getConversionRate(req.user?.id);
    const quotaRemaining = req.user?.id ? await getDailyQuotaRemaining(req.user.id) : DAILY_AZM_LIMIT;

    return res.json({
      success: true,
      ...rateInfo,
      quotaRemaining,
    });
  } catch (err) {
    logger.error({ err: err }, '[azmConvert] rate error');
    return res.status(500).json({ success: false, message: 'Failed to get rate.' });
  }
}

// ── GET /api/azm-convert/history ────────────────────────────────────────────
async function getConversionHistory(req, res) {
  try {
    const history = await prisma.azmConversionLog.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return res.json({ success: true, history });
  } catch (err) {
    logger.error({ err: err }, '[azmConvert] history error');
    return res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
}

module.exports = {
  convertAzmToUsdc,
  getRate,
  getConversionHistory,
  getConversionRate,
};
