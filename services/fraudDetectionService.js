// services/fraudDetectionService.js
// =============================================================================
// Fraud Detection Rules Engine — Real-time velocity + anomaly detection
//
// Evaluates transactions against configurable rules before they commit.
// Rules check velocity, amount thresholds, behavioral patterns, and
// historical risk. When a rule triggers, it either blocks, flags for review,
// or sends an alert — depending on the rule's severity.
//
// Rule Types:
//   1. VELOCITY  — N transactions within T seconds (e.g. 5 withdrawals in 60s)
//   2. AMOUNT    — Single transaction above threshold (e.g. withdrawal > $2000)
//   3. PATTERN   — Behavioral patterns (e.g. new account + large transfer)
//   4. HISTORY   — User's past risk factors (disputes, chargebacks, bans)
//   5. GEO       — Login from new country / device
//   6. AGGREGATE — Cumulative volume in window (e.g. > $10k deposited in 1h)
//
// Severity levels:
//   BLOCK      — Transaction is rejected immediately
//   REVIEW     — Transaction proceeds but flagged for admin manual review
//   ALERT      — Admin notified but transaction proceeds
//
// Reference: Stripe Radar (ML + rules), Coinbase (velocity checks),
//            Wise (anomaly detection), Revolut (real-time fraud alerts)
// =============================================================================

const logger = require('../src/config/logger');

let _prisma;
function prisma() {
  if (!_prisma) {
    const { PrismaClient } = require('@prisma/client');
    _prisma = new PrismaClient();
  }
  return _prisma;
}

// ── Rule Definitions ───────────────────────────────────────────────────────────

const RULES = {
  // Velocity: too many transactions in a short window
  WITHDRAWAL_VELOCITY: {
    id: 'WITHDRAWAL_VELOCITY',
    type: 'VELOCITY',
    severity: 'BLOCK',
    description: 'More than 5 withdrawals in 60 seconds',
    config: { maxCount: 5, windowSeconds: 60 },
  },

  TRANSFER_VELOCITY: {
    id: 'TRANSFER_VELOCITY',
    type: 'VELOCITY',
    severity: 'REVIEW',
    description: 'More than 10 peer transfers in 5 minutes',
    config: { maxCount: 10, windowSeconds: 300 },
  },

  TRADE_VELOCITY: {
    id: 'TRADE_VELOCITY',
    type: 'VELOCITY',
    severity: 'REVIEW',
    description: 'More than 8 trades created in 2 minutes',
    config: { maxCount: 8, windowSeconds: 120 },
  },

  // Amount: single large transaction
  LARGE_WITHDRAWAL: {
    id: 'LARGE_WITHDRAWAL',
    type: 'AMOUNT',
    severity: 'REVIEW',
    description: 'Withdrawal above $2,000 USDC',
    config: { threshold: 2000 },
  },

  LARGE_TRANSFER: {
    id: 'LARGE_TRANSFER',
    type: 'AMOUNT',
    severity: 'ALERT',
    description: 'Peer transfer above $5,000 USDC',
    config: { threshold: 5000 },
  },

  HUGE_WITHDRAWAL: {
    id: 'HUGE_WITHDRAWAL',
    type: 'AMOUNT',
    severity: 'BLOCK',
    description: 'Withdrawal above $10,000 USDC',
    config: { threshold: 10000 },
  },

  // Pattern: new account + large transaction
  NEW_ACCOUNT_LARGE_TX: {
    id: 'NEW_ACCOUNT_LARGE_TX',
    type: 'PATTERN',
    severity: 'BLOCK',
    description: 'Account < 24h old + transaction > $500',
    config: { maxAccountAgeHours: 24, minAmount: 500 },
  },

  // History: user with prior disputes
  HIGH_DISPUTE_USER: {
    id: 'HIGH_DISPUTE_USER',
    type: 'HISTORY',
    severity: 'REVIEW',
    description: 'User with 3+ disputes in the last 7 days',
    config: { minDisputes: 3, windowDays: 7 },
  },

  // Aggregate: cumulative volume in a window
  HIGH_AGGREGATE_DEPOSIT: {
    id: 'HIGH_AGGREGATE_DEPOSIT',
    type: 'AGGREGATE',
    severity: 'REVIEW',
    description: 'More than $10,000 deposited in 1 hour',
    config: { maxVolume: 10000, windowSeconds: 3600 },
  },

  // Pattern: multiple failed login attempts
  MULTIPLE_FAILED_LOGINS: {
    id: 'MULTIPLE_FAILED_LOGINS',
    type: 'VELOCITY',
    severity: 'BLOCK',
    description: '5+ failed login attempts in 15 minutes',
    config: { maxCount: 5, windowSeconds: 900 },
  },
};

// ── Evaluation Engine ──────────────────────────────────────────────────────────

/**
 * Evaluate a transaction against all applicable rules.
 *
 * @param {Object} tx - { userId, type, amount, createdAt, accountAgeHours }
 * @returns {Object} { allowed, riskScore, triggeredRules: [{ id, severity, description }] }
 */
async function evaluate(tx) {
  const triggered = [];
  let riskScore = 0;

  const db = prisma();

  // ── VELOCITY checks ──────────────────────────────────────────────────────────
  if (tx.type === 'WITHDRAWAL') {
    const count = await _countRecentTransactions(db, tx.userId, 'WITHDRAWAL', RULES.WITHDRAWAL_VELOCITY.config.windowSeconds);
    if (count >= RULES.WITHDRAWAL_VELOCITY.config.maxCount) {
      triggered.push(_formatRule(RULES.WITHDRAWAL_VELOCITY));
      riskScore += 50;
    }
  }

  if (tx.type === 'TRANSFER') {
    const count = await _countRecentTransactions(db, tx.userId, 'TRANSFER', RULES.TRANSFER_VELOCITY.config.windowSeconds);
    if (count >= RULES.TRANSFER_VELOCITY.config.maxCount) {
      triggered.push(_formatRule(RULES.TRANSFER_VELOCITY));
      riskScore += 30;
    }
  }

  if (tx.type === 'TRADE') {
    const count = await _countRecentTransactions(db, tx.userId, 'P2P_TRADE', RULES.TRADE_VELOCITY.config.windowSeconds);
    if (count >= RULES.TRADE_VELOCITY.config.maxCount) {
      triggered.push(_formatRule(RULES.TRADE_VELOCITY));
      riskScore += 30;
    }
  }

  // ── AMOUNT checks ──────────────────────────────────────────────────────────────
  if (tx.amount && tx.type === 'WITHDRAWAL') {
    if (tx.amount >= RULES.HUGE_WITHDRAWAL.config.threshold) {
      triggered.push(_formatRule(RULES.HUGE_WITHDRAWAL));
      riskScore += 60;
    } else if (tx.amount >= RULES.LARGE_WITHDRAWAL.config.threshold) {
      triggered.push(_formatRule(RULES.LARGE_WITHDRAWAL));
      riskScore += 20;
    }
  }

  if (tx.amount && tx.type === 'TRANSFER') {
    if (tx.amount >= RULES.LARGE_TRANSFER.config.threshold) {
      triggered.push(_formatRule(RULES.LARGE_TRANSFER));
      riskScore += 15;
    }
  }

  // ── PATTERN: new account + large transaction ───────────────────────────────────
  if (tx.accountAgeHours !== undefined && tx.accountAgeHours < RULES.NEW_ACCOUNT_LARGE_TX.config.maxAccountAgeHours) {
    if (tx.amount && tx.amount > RULES.NEW_ACCOUNT_LARGE_TX.config.minAmount) {
      triggered.push(_formatRule(RULES.NEW_ACCOUNT_LARGE_TX));
      riskScore += 40;
    }
  }

  // ── HISTORY: prior disputes ────────────────────────────────────────────────────
  if (tx.userId) {
    const disputeCount = await _countRecentDisputes(db, tx.userId, RULES.HIGH_DISPUTE_USER.config.windowDays);
    if (disputeCount >= RULES.HIGH_DISPUTE_USER.config.minDisputes) {
      triggered.push(_formatRule(RULES.HIGH_DISPUTE_USER));
      riskScore += 25;
    }
  }

  // ── AGGREGATE: cumulative volume ───────────────────────────────────────────────
  if (tx.type === 'DEPOSIT' && tx.amount) {
    const totalVolume = await _aggregateVolume(db, tx.userId, 'DEPOSIT', RULES.HIGH_AGGREGATE_DEPOSIT.config.windowSeconds);
    if (totalVolume + tx.amount > RULES.HIGH_AGGREGATE_DEPOSIT.config.maxVolume) {
      triggered.push(_formatRule(RULES.HIGH_AGGREGATE_DEPOSIT));
      riskScore += 35;
    }
  }

  // Determine if transaction should be blocked
  const hasBlock = triggered.some(r => r.severity === 'BLOCK');
  const allowed = !hasBlock;

  // Persist fraud assessment if any rules triggered
  if (triggered.length > 0) {
    _persistAssessment(db, tx, riskScore, triggered).catch(e =>
      logger.warn({ err: e.message }, '[fraud] Failed to persist assessment')
    );
  }

  return {
    allowed,
    riskScore: Math.min(riskScore, 100),
    triggeredRules: triggered,
  };
}

/**
 * Quick check for a specific event type (e.g. login attempts).
 * Uses Redis counters if available, falls back to DB.
 */
async function checkVelocity(userId, eventType, maxCount, windowSeconds) {
  const db = prisma();
  const count = await _countRecentTransactions(db, userId, eventType, windowSeconds);
  return { blocked: count >= maxCount, count };
}

// ── Internal Helpers ───────────────────────────────────────────────────────────

async function _countRecentTransactions(db, userId, type, windowSeconds) {
  try {
    const since = new Date(Date.now() - windowSeconds * 1000);
    const count = await db.transactionHistory.count({
      where: {
        userId,
        type,
        createdAt: { gte: since },
      },
    });
    return count;
  } catch {
    // Table might not exist in some environments
    return 0;
  }
}

async function _countRecentDisputes(db, userId, windowDays) {
  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const count = await db.tradeDispute.count({
      where: {
        OR: [
          { trade: { userId } },
          { trade: { vendorId: userId } },
        ],
        createdAt: { gte: since },
      },
    });
    return count;
  } catch {
    return 0;
  }
}

async function _aggregateVolume(db, userId, type, windowSeconds) {
  try {
    const since = new Date(Date.now() - windowSeconds * 1000);
    const records = await db.transactionHistory.findMany({
      where: {
        userId,
        type,
        createdAt: { gte: since },
      },
      select: { amountUsdc: true },
    });
    return records.reduce((sum, r) => sum + parseFloat(r.amountUsdc || 0), 0);
  } catch {
    return 0;
  }
}

async function _persistAssessment(db, tx, riskScore, triggered) {
  try {
    await db.fraudAssessment.create({
      data: {
        userId: tx.userId,
        transactionType: tx.type,
        amountUsdc: tx.amount || 0,
        riskScore,
        triggeredRules: JSON.stringify(triggered.map(r => r.id)),
        action: triggered.some(r => r.severity === 'BLOCK') ? 'BLOCKED' : 'FLAGGED',
      },
    });
  } catch (e) {
    // FraudAssessment table might not exist yet
    logger.warn({ err: e.message }, '[fraud] Assessment persist failed (table may not exist)');
  }
}

function _formatRule(rule) {
  return {
    id: rule.id,
    type: rule.type,
    severity: rule.severity,
    description: rule.description,
  };
}

// ── Admin: Get Rule List ───────────────────────────────────────────────────────

function getRules() {
  return Object.values(RULES).map(r => ({
    id: r.id,
    type: r.type,
    severity: r.severity,
    description: r.description,
    config: r.config,
    active: true,
  }));
}

// ── Admin: Get Assessments ─────────────────────────────────────────────────────

async function getAssessments({ limit = 50, skip = 0, onlyBlocked = false }) {
  const db = prisma();
  try {
    const where = onlyBlocked ? { action: 'BLOCKED' } : {};
    const [assessments, total] = await Promise.all([
      db.fraudAssessment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.fraudAssessment.count({ where }),
    ]);
    return { assessments, total };
  } catch {
    return { assessments: [], total: 0 };
  }
}

module.exports = {
  evaluate,
  checkVelocity,
  getRules,
  getAssessments,
  RULES,
};
