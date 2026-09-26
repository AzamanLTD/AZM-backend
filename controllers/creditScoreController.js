// controllers/creditScoreController.js
// =============================================================================
// AZAMAN V3 — On-Platform Credit Scoring (Phase 5)
//
// Calculates a FICO-style credit score (300-850) from:
//   1. Susu participation (35%): on-time contributions, cycle completions,
//      position reliability, trust score
//   2. Trade history (25%): completed trades, completion rate, volume,
//      dispute rate
//   3. Account age & verification (15%): KYC status, account age, phone verified
//   4. Financial behavior (15%): withdrawal frequency, balance stability,
//      savings activity
//   5. Reputation (10%): reviews, strike history, ban status
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

const MIN_SCORE = 300;
const MAX_SCORE = 850;

const WEIGHTS = {
  susu: 35,
  trade: 25,
  account: 15,
  financial: 15,
  reputation: 10,
};

function clampScore(score) {
  return Math.round(Math.max(MIN_SCORE, Math.min(MAX_SCORE, score)));
}

// ── 1. SUSU SCORE ───────────────────────────────────────────────────────────
async function calculateSusuScore(userId) {
  const memberships = await prisma.susuMember.findMany({
    where: { userId },
    include: {
      contributions: true,
      susu: { select: { cycles: { select: { status: true } } } },
    },
  });

  if (memberships.length === 0) return 50;

  let totalContributions = 0;
  let onTimeContributions = 0;
  let defaultedCount = 0;
  let completedCycles = 0;
  let totalCycles = 0;
  let trustScores = [];

  for (const membership of memberships) {
    trustScores.push(parseFloat(membership.trustScore.toString()));
    if (membership.defaultedAt) defaultedCount++;

    const cycles = membership.susu.cycles || [];
    totalCycles += cycles.length;
    completedCycles += cycles.filter(c => c.status === 'COMPLETED').length;

    for (const contribution of membership.contributions) {
      totalContributions++;
      if (contribution.status === 'PAID' && parseFloat(contribution.shortfall?.toString() || '0') === 0) {
        onTimeContributions++;
      }
    }
  }

  const onTimeRate = totalContributions > 0 ? onTimeContributions / totalContributions : 0.5;
  const onTimePoints = onTimeRate * 40;

  const completionRate = totalCycles > 0 ? completedCycles / totalCycles : 0.5;
  const completionPoints = completionRate * 25;

  const avgTrust = trustScores.length > 0
    ? trustScores.reduce((a, b) => a + b, 0) / trustScores.length : 50;
  const trustPoints = (avgTrust / 100) * 20;

  const defaultPoints = Math.max(0, 15 - defaultedCount * 5);

  return Math.min(100, onTimePoints + completionPoints + trustPoints + defaultPoints);
}

// ── 2. TRADE SCORE ──────────────────────────────────────────────────────────
async function calculateTradeScore(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tradesCompleted: true, completionRate: true, totalVolumeUsdc: true },
  });

  if (!user || user.tradesCompleted === 0) return 50;

  const disputeCount = await prisma.peerTransfer.count({
    where: {
      OR: [{ senderId: userId }, { receiverId: userId }],
      status: 'DISPUTED',
    },
  });

  const volume = parseFloat(user.totalVolumeUsdc?.toString() || '0');
  const volumePoints = Math.min(30, Math.log10(Math.max(1, volume)) * 5);

  const completionRate = parseFloat(user.completionRate?.toString() || '0');
  const completionPoints = (completionRate / 100) * 35;

  const countPoints = Math.min(20, Math.log10(Math.max(1, user.tradesCompleted)) * 7);

  const disputeRate = user.tradesCompleted > 0 ? disputeCount / user.tradesCompleted : 0;
  const disputePoints = Math.max(0, 15 - disputeRate * 50);

  return Math.min(100, volumePoints + completionPoints + countPoints + disputePoints);
}

// ── 3. ACCOUNT SCORE ────────────────────────────────────────────────────────
async function calculateAccountScore(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, phoneVerified: true, createdAt: true, isTwoFactorEnabled: true },
  });

  if (!user) return 30;

  let score = 0;
  score += user.kycStatus === 'VERIFIED' ? 35 : user.kycStatus === 'PENDING' ? 15 : 0;
  if (user.phoneVerified) score += 15;
  if (user.isTwoFactorEnabled) score += 15;

  const ageDays = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  score += Math.min(35, Math.log10(Math.max(1, ageDays)) * 10);

  return Math.min(100, score);
}

// ── 4. FINANCIAL SCORE ──────────────────────────────────────────────────────
async function calculateFinancialScore(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { availableBalance: true },
  });

  if (!user) return 30;

  let score = 0;
  const balance = parseFloat(user.availableBalance?.toString() || '0');
  if (balance > 1000) score += 30;
  else if (balance > 100) score += 20;
  else if (balance > 10) score += 10;
  else score += 5;

  const savingsGoals = await prisma.savingsGoal.count({
    where: { userId, status: 'ACTIVE' },
  });
  score += Math.min(25, savingsGoals * 8);

  const vaultDeposits = await prisma.vaultDeposit.count({
    where: { userId, status: 'COMPLETED' },
  });
  score += Math.min(25, vaultDeposits * 12);

  const recentTxns = await prisma.transactionHistory.count({
    where: { userId, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  });
  if (recentTxns >= 10 && recentTxns <= 100) score += 20;
  else if (recentTxns >= 5) score += 15;
  else if (recentTxns >= 1) score += 10;

  return Math.min(100, score);
}

// ── 5. REPUTATION SCORE ─────────────────────────────────────────────────────
async function calculateReputationScore(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { positiveReviews: true, negativeReviews: true, strikeCount: true, banStatus: true },
  });

  if (!user) return 50;

  let score = 0;
  const totalReviews = user.positiveReviews + user.negativeReviews;
  if (totalReviews > 0) {
    score += (user.positiveReviews / totalReviews) * 40;
  } else {
    score += 20;
  }

  score += Math.max(0, 30 - user.strikeCount * 10);

  if (user.banStatus === 'ACTIVE') score += 30;
  else if (user.banStatus === 'SUSPENDED') score += 5;

  return Math.min(100, score);
}

// ── MAIN: Calculate full credit score ──────────────────────────────────────
async function calculateCreditScore(userId) {
  const [susu, trade, account, financial, reputation] = await Promise.all([
    calculateSusuScore(userId),
    calculateTradeScore(userId),
    calculateAccountScore(userId),
    calculateFinancialScore(userId),
    calculateReputationScore(userId),
  ]);

  const weightedScore =
    susu * (WEIGHTS.susu / 100) +
    trade * (WEIGHTS.trade / 100) +
    account * (WEIGHTS.account / 100) +
    financial * (WEIGHTS.financial / 100) +
    reputation * (WEIGHTS.reputation / 100);

  const scaledScore = MIN_SCORE + (weightedScore / 100) * (MAX_SCORE - MIN_SCORE);
  const score = clampScore(scaledScore);

  let rating, band;
  if (score >= 750) { rating = 'EXCELLENT'; band = 'A'; }
  else if (score >= 670) { rating = 'GOOD'; band = 'B'; }
  else if (score >= 580) { rating = 'FAIR'; band = 'C'; }
  else if (score >= 500) { rating = 'POOR'; band = 'D'; }
  else { rating = 'VERY_POOR'; band = 'E'; }

  return {
    score,
    rating,
    band,
    components: {
      susu: { score: Math.round(susu), weight: WEIGHTS.susu },
      trade: { score: Math.round(trade), weight: WEIGHTS.trade },
      account: { score: Math.round(account), weight: WEIGHTS.account },
      financial: { score: Math.round(financial), weight: WEIGHTS.financial },
      reputation: { score: Math.round(reputation), weight: WEIGHTS.reputation },
    },
    calculatedAt: new Date().toISOString(),
  };
}

// ── CONTROLLERS ─────────────────────────────────────────────────────────────

async function getCreditScore(req, res) {
  try {
    const result = await calculateCreditScore(req.user.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err: err }, '[creditScore] error');
    return res.status(500).json({ success: false, message: 'Failed to calculate credit score.' });
  }
}

async function getCreditScoreHistory(req, res) {
  try {
    const history = await prisma.creditScoreSnapshot.findMany({
      where: { userId: req.user.id },
      orderBy: { calculatedAt: 'desc' },
      take: 12,
    });
    return res.json({ success: true, history });
  } catch (err) {
    logger.error({ err: err }, '[creditScore] history error');
    return res.status(500).json({ success: false, message: 'Failed to load credit score history.' });
  }
}

async function refreshCreditScore(req, res) {
  try {
    const userId = req.user.id;
    const result = await calculateCreditScore(userId);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.creditScoreSnapshot.upsert({
      where: { userId_calculatedAt: { userId, calculatedAt: today } },
      create: {
        userId,
        score: result.score,
        rating: result.rating,
        band: result.band,
        susuComponent: result.components.susu.score,
        tradeComponent: result.components.trade.score,
        accountComponent: result.components.account.score,
        financialComponent: result.components.financial.score,
        reputationComponent: result.components.reputation.score,
        calculatedAt: today,
      },
      update: {
        score: result.score,
        rating: result.rating,
        band: result.band,
        susuComponent: result.components.susu.score,
        tradeComponent: result.components.trade.score,
        accountComponent: result.components.account.score,
        financialComponent: result.components.financial.score,
        reputationComponent: result.components.reputation.score,
      },
    });

    return res.json({ success: true, ...result, message: 'Credit score refreshed.' });
  } catch (err) {
    logger.error({ err: err }, '[creditScore] refresh error');
    return res.status(500).json({ success: false, message: 'Failed to refresh credit score.' });
  }
}

async function getCreditFactors(req, res) {
  try {
    const userId = req.user.id;
    const result = await calculateCreditScore(userId);

    const recommendations = [];

    if (result.components.susu.score < 70) {
      recommendations.push({
        factor: 'Susu Participation',
        action: 'Join a Susu group and maintain on-time contributions to boost your score.',
        potentialGain: Math.round((70 - result.components.susu.score) * (WEIGHTS.susu / 100) * 5.5),
      });
    }

    if (result.components.account.score < 80) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { kycStatus: true, isTwoFactorEnabled: true },
      });
      if (user.kycStatus !== 'VERIFIED') {
        recommendations.push({
          factor: 'Identity Verification',
          action: 'Complete KYC verification to unlock higher credit limits.',
          potentialGain: 20,
        });
      }
      if (!user.isTwoFactorEnabled) {
        recommendations.push({
          factor: 'Security',
          action: 'Enable two-factor authentication to improve your security score.',
          potentialGain: 10,
        });
      }
    }

    if (result.components.trade.score < 60) {
      recommendations.push({
        factor: 'Trade Activity',
        action: 'Complete more P2P trades with high completion rates to improve trading history.',
        potentialGain: Math.round((60 - result.components.trade.score) * (WEIGHTS.trade / 100) * 5.5),
      });
    }

    if (result.components.financial.score < 60) {
      recommendations.push({
        factor: 'Financial Habits',
        action: 'Maintain a stable balance, create savings goals, or join a vault.',
        potentialGain: Math.round((60 - result.components.financial.score) * (WEIGHTS.financial / 100) * 5.5),
      });
    }

    return res.json({ success: true, ...result, recommendations });
  } catch (err) {
    logger.error({ err: err }, '[creditScore] factors error');
    return res.status(500).json({ success: false, message: 'Failed to load credit factors.' });
  }
}

async function getUserCreditScore(req, res) {
  try {
    const result = await calculateCreditScore(parseInt(req.params.userId, 10));
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err: err }, '[creditScore] admin error');
    return res.status(500).json({ success: false, message: 'Failed to calculate credit score.' });
  }
}

module.exports = {
  getCreditScore,
  getCreditScoreHistory,
  refreshCreditScore,
  getCreditFactors,
  getUserCreditScore,
  calculateCreditScore,
};
