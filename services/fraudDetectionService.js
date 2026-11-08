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

// ── Typed failures ────────────────────────────────────────────────────────────
// A risk decision must never be manufactured out of a missing signal. These two
// errors are how a caller learns that the answer is UNAVAILABLE (the data could
// not be read) or INVALID (the policy itself cannot be trusted), as distinct
// from ALLOWED.
class RiskDataUnavailableError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'RiskDataUnavailableError';
    // A single, stable code so no caller has to pattern-match a message.
    this.code = 'RISK_DATA_UNAVAILABLE';
    this.details = details;
  }
}

class GhsRiskPolicyError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'GhsRiskPolicyError';
    this.code = 'RISK_POLICY_INVALID';
    this.details = details;
  }
}

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

// ── Asset-aware amount policy ─────────────────────────────────────────────────
//
// The amount thresholds above are USDC thresholds. A native-GHS payout amount is
// NOT comparable to them: 10,000 GHS is a few hundred dollars, so applying the
// USDC "huge withdrawal" block to GHS would freeze perfectly ordinary payouts —
// and converting the GHS amount to USDC first would make a RISK decision depend
// on a live FX rate, which is both an FX coupling the payout does not otherwise
// have and a way for the gate to disappear whenever the rate source is down.
//
// GHS thresholds are therefore a SEPARATE, explicitly configured policy. No
// default numbers are invented here. Unset means the amount dimension is simply
// not evaluated for GHS, and the decision says so (amountPolicy / policyGaps)
// rather than quietly implying the check ran and passed. A malformed policy is a
// configuration error and THROWS, so callers refuse the payout instead of
// proceeding with a gate they cannot trust.
/**
 * Parse a GHS policy value into exact integer PESEWAS.
 *
 * Accepts a decimal string ("5000.00") or a number with at most two decimal
 * places. Returns null for anything that is not an exact, non-exponent decimal:
 * the caller treats that as an invalid policy and refuses the payout.
 */
function parseExactPesewas(value) {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : '')
    : (typeof value === 'string' ? value.trim() : '');
  if (!text) return null;
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const pesewas = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return pesewas;
}

function resolveGhsAmountPolicy() {
  const raw = process.env.GHS_RISK_AMOUNT_POLICY;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    // ABSENT IS NOT PERMISSION. No number is invented here; the decision carries
    // a gap so the payout gate can refuse instead of paying out on a dimension
    // nobody configured.
    return { policy: null, gaps: ['GHS_AMOUNT_POLICY_MISSING'], missing: ['largeGhs', 'hugeGhs', 'newAccountMinGhs'] };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new GhsRiskPolicyError(`GHS_RISK_AMOUNT_POLICY is not valid JSON: ${err.message}`, { reason: 'NOT_JSON' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GhsRiskPolicyError('GHS_RISK_AMOUNT_POLICY must be a JSON object', { reason: 'NOT_AN_OBJECT' });
  }
  const keys = ['largeGhs', 'hugeGhs', 'newAccountMinGhs'];
  const policy = {};
  const missing = [];
  const invalid = [];
  for (const key of keys) {
    const rawValue = parsed[key];
    if (rawValue === undefined || rawValue === null || rawValue === '') { missing.push(key); continue; }
    // EXACT PESEWA PARSING. A threshold decides whether money leaves the
    // platform, so it is never a float: "5000.007" is rejected rather than
    // silently rounded into a different policy, and exponent notation ("1e3")
    // is refused instead of being read as a number.
    const pesewas = parseExactPesewas(rawValue);
    if (pesewas === null || pesewas <= 0n) { invalid.push(key); continue; }
    policy[key] = Number(pesewas) / 100;
    policy[`${key}Pesewas`] = pesewas;
  }
  if (invalid.length) {
    throw new GhsRiskPolicyError(`GHS_RISK_AMOUNT_POLICY.${invalid.join(', ')} must be a positive number`, { reason: 'INVALID_VALUES', invalid });
  }
  if (missing.length) {
    // PARTIAL IS NOT CONFIGURED. One threshold out of three silently skips two
    // rules, which is the same bypass in a quieter costume.
    return { policy: null, gaps: ['GHS_AMOUNT_POLICY_INCOMPLETE'], missing };
  }
  // Ordering is validated in exact pesewas — the same unit the amount dimension
  // compares — so a threshold can never sit "below" another by rounding.
  const cents = (v) => Math.round(v * 100);
  if (policy.largeGhsPesewas >= policy.hugeGhsPesewas) {
    throw new GhsRiskPolicyError('GHS_RISK_AMOUNT_POLICY.largeGhs must be less than hugeGhs', { reason: 'ORDERING', largeGhs: policy.largeGhs, hugeGhs: policy.hugeGhs });
  }
  if (policy.newAccountMinGhsPesewas >= policy.hugeGhsPesewas) {
    throw new GhsRiskPolicyError('GHS_RISK_AMOUNT_POLICY.newAccountMinGhs must be less than hugeGhs', { reason: 'ORDERING', newAccountMinGhs: policy.newAccountMinGhs, hugeGhs: policy.hugeGhs });
  }
  return { policy, gaps: [], missing: [] };
}

const GHS_RULES = {
  GHS_LARGE_WITHDRAWAL: { id: 'GHS_LARGE_WITHDRAWAL', type: 'AMOUNT', severity: 'REVIEW', description: 'GHS withdrawal above the configured large-withdrawal threshold' },
  GHS_HUGE_WITHDRAWAL: { id: 'GHS_HUGE_WITHDRAWAL', type: 'AMOUNT', severity: 'BLOCK', description: 'GHS withdrawal above the configured huge-withdrawal threshold' },
  GHS_NEW_ACCOUNT_LARGE_TX: { id: 'GHS_NEW_ACCOUNT_LARGE_TX', type: 'PATTERN', severity: 'BLOCK', description: 'Account < 24h old + GHS withdrawal above the configured new-account threshold' },
};

// ── Evaluation Engine ──────────────────────────────────────────────────────────

/**
 * Evaluate a transaction against all applicable rules.
 *
 * @param {Object} tx - { userId, type, amount, createdAt, accountAgeHours }
 * @returns {Object} { allowed, riskScore, triggeredRules: [{ id, severity, description }] }
 */
async function evaluate(tx) {
  if (!tx || typeof tx !== 'object') throw new Error('evaluate(tx) requires a transaction descriptor');
  const triggered = [];
  let riskScore = 0;

  const asset = String(tx.asset || 'USDC').toUpperCase();
  const isGhs = asset === 'GHS';
  // Every stored withdrawal type counts toward the same velocity envelope.
  const velocityTypes = Array.isArray(tx.velocityTypes) && tx.velocityTypes.length
    ? tx.velocityTypes
    : (tx.type ? [tx.type] : []);
  // Throws on a malformed GHS policy: callers must refuse, not guess.
  const ghsResolution = isGhs ? resolveGhsAmountPolicy() : { policy: null, gaps: [], missing: [] };
  const ghsPolicy = ghsResolution.policy;
  const policyGaps = [...ghsResolution.gaps];

  // STRICT RISK-DATA MODE. A money-out decision is only trustworthy if every
  // query behind it actually answered. In FAIL_CLOSED mode a failed read throws
  // RiskDataUnavailableError instead of being reported as a zero count — the
  // difference between "no suspicious withdrawals" and "nobody could look" is
  // the whole point of a gate. Non-payout callers keep the historical
  // best-effort behaviour.
  const strict = String(tx.riskDataMode || '').toUpperCase() === 'FAIL_CLOSED';
  const db = tx.db || prisma();
  const dataOpts = { failClosed: strict };

  // ── VELOCITY checks ──────────────────────────────────────────────────────────
  if (tx.type === 'WITHDRAWAL' || isGhs) {
    const count = await _countRecentTransactionsByTypes(db, tx.userId, velocityTypes, RULES.WITHDRAWAL_VELOCITY.config.windowSeconds, dataOpts);
    if (count >= RULES.WITHDRAWAL_VELOCITY.config.maxCount) {
      triggered.push(_formatRule(RULES.WITHDRAWAL_VELOCITY));
      riskScore += 50;
    }
  }

  if (tx.type === 'TRANSFER') {
    const count = await _countRecentTransactions(db, tx.userId, 'TRANSFER', RULES.TRANSFER_VELOCITY.config.windowSeconds, dataOpts);
    if (count >= RULES.TRANSFER_VELOCITY.config.maxCount) {
      triggered.push(_formatRule(RULES.TRANSFER_VELOCITY));
      riskScore += 30;
    }
  }

  if (tx.type === 'TRADE') {
    const count = await _countRecentTransactions(db, tx.userId, 'P2P_TRADE', RULES.TRADE_VELOCITY.config.windowSeconds, dataOpts);
    if (count >= RULES.TRADE_VELOCITY.config.maxCount) {
      triggered.push(_formatRule(RULES.TRADE_VELOCITY));
      riskScore += 30;
    }
  }

  // ── AMOUNT checks ──────────────────────────────────────────────────────────────
  if (tx.amount && (tx.type === 'WITHDRAWAL' || isGhs)) {
    if (isGhs) {
      // NEVER the USDC thresholds: those numbers mean nothing in GHS.
      if (!ghsPolicy) {
        // The gap is already on the decision (GHS_AMOUNT_POLICY_MISSING /
        // _INCOMPLETE): the dimension was NOT evaluated, and the caller refuses.
      } else {
        // EXACT PESEWAS, never a float: the GHS dimension must not depend on
        // JavaScript's Number() rounding of the customer's amount.
        const ghsPesewas = tx.amountGhsPesewas === undefined || tx.amountGhsPesewas === null
          ? parseExactPesewas(tx.amountExact !== undefined ? tx.amountExact : tx.amount)
          : BigInt(tx.amountGhsPesewas);
        if (ghsPolicy.hugeGhsPesewas !== undefined && ghsPesewas !== null && ghsPesewas >= ghsPolicy.hugeGhsPesewas) {
          triggered.push(_formatRule(GHS_RULES.GHS_HUGE_WITHDRAWAL));
          riskScore += 60;
        } else if (ghsPolicy.largeGhsPesewas !== undefined && ghsPesewas !== null && ghsPesewas >= ghsPolicy.largeGhsPesewas) {
          triggered.push(_formatRule(GHS_RULES.GHS_LARGE_WITHDRAWAL));
          riskScore += 20;
        }
      }
    } else if (tx.amount >= RULES.HUGE_WITHDRAWAL.config.threshold) {
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
    if (isGhs) {
      // The USDC minAmount is not a GHS minAmount. Without a configured GHS
      // figure this pattern is not evaluated, and the decision says so.
      if (!ghsPolicy) {
        // Not evaluated; the resolver's gap already records why.
      } else if (tx.amountGhsPesewas !== undefined && tx.amountGhsPesewas !== null
        && BigInt(tx.amountGhsPesewas) > ghsPolicy.newAccountMinGhsPesewas) {
        triggered.push(_formatRule(GHS_RULES.GHS_NEW_ACCOUNT_LARGE_TX));
        riskScore += 40;
      }
    } else if (tx.amount && tx.amount > RULES.NEW_ACCOUNT_LARGE_TX.config.minAmount) {
      triggered.push(_formatRule(RULES.NEW_ACCOUNT_LARGE_TX));
      riskScore += 40;
    }
  }

  // ── HISTORY: prior disputes ────────────────────────────────────────────────────
  if (tx.userId) {
    const disputeCount = await _countRecentDisputes(db, tx.userId, RULES.HIGH_DISPUTE_USER.config.windowDays, dataOpts);
    if (disputeCount >= RULES.HIGH_DISPUTE_USER.config.minDisputes) {
      triggered.push(_formatRule(RULES.HIGH_DISPUTE_USER));
      riskScore += 25;
    }
  }

  // ── AGGREGATE: cumulative volume ───────────────────────────────────────────────
  if (tx.type === 'DEPOSIT' && tx.amount) {
    const totalVolume = await _aggregateVolume(db, tx.userId, 'DEPOSIT', RULES.HIGH_AGGREGATE_DEPOSIT.config.windowSeconds, dataOpts);
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
    _persistAssessment(db, { ...tx, asset }, riskScore, triggered).catch(e =>
      logger.warn({ err: e.message }, '[fraud] Failed to persist assessment')
    );
  }

  return {
    allowed,
    riskScore: Math.min(riskScore, 100),
    triggeredRules: triggered,
    asset,
    // What the amount dimension actually did, so no caller can claim a check
    // ran when the policy behind it does not exist.
    amountPolicy: isGhs ? (ghsPolicy ? 'APPLIED' : 'NOT_CONFIGURED') : 'APPLIED',
    riskDataMode: strict ? 'FAIL_CLOSED' : 'BEST_EFFORT',
    amountPolicyMissing: ghsResolution.missing || [],
    policyGaps,
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

async function _countRecentTransactions(db, userId, type, windowSeconds, options = {}) {
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
  } catch (error) {
    // FAIL CLOSED: "we could not look" is not "nothing to see". Returning 0 here
    // let a failed query satisfy a risk check, so a database outage became
    // permission to move customer money.
    if (options.failClosed) {
      throw new RiskDataUnavailableError('Unable to establish transaction velocity.', { query: 'transactionHistory.count', err: error && error.message });
    }
    logger.warn({ err: error && error.message }, '[fraud] transaction velocity unavailable');
    return 0;
  }
}

/**
 * Count withdrawals across EVERY stored withdrawal type. Native-GHS payouts are
 * written as WITHDRAWAL_FIAT while the older fiat path writes WITHDRAWAL, so a
 * single-type count would let a customer alternate rails to escape the velocity
 * envelope entirely.
 */
async function _countRecentTransactionsByTypes(db, userId, types, windowSeconds, options = {}) {
  try {
    const since = new Date(Date.now() - windowSeconds * 1000);
    return await db.transactionHistory.count({
      where: { userId, type: { in: types }, createdAt: { gte: since } },
    });
  } catch (error) {
    // FAIL CLOSED: "we could not look" is not "nothing to see". Returning 0 here
    // let a failed query satisfy a risk check, so a database outage became
    // permission to move customer money.
    if (options.failClosed) {
      throw new RiskDataUnavailableError('Unable to establish withdrawal velocity.', { query: 'transactionHistory.count', err: error && error.message });
    }
    logger.warn({ err: error && error.message }, '[fraud] withdrawal velocity unavailable');
    return 0;
  }
}

async function _countRecentDisputes(db, userId, windowDays, options = {}) {
  try {
    const since = new Date(Date.now() - (windowDays * 24 * 60 * 60 * 1000));
    // §P0 THIS QUERY NEVER RAN. It read `db.tradeDispute`, a model this schema
    // does not have, so every call threw a TypeError that the old catch swallowed
    // and reported as "no disputes". A rule that can never fire is worse than no
    // rule: it looked like history was clear.
    //
    // There is no single dispute table. Two real ones describe a customer's
    // dispute history, and both are counted:
    //   EscrowDispute  — raised by the user, or on an escrow they are party to.
    //   DisputeResolution — a resolved dispute on a trade they were party to.
    // A failed read still refuses in FAIL_CLOSED mode; it is no longer zero.
    const [raised, resolved] = await Promise.all([
      db.escrowDispute.count({
        where: {
          createdAt: { gte: since },
          OR: [
            { raisedById: userId },
            { escrow: { payerId: userId } },
            { escrow: { payeeId: userId } },
          ],
        },
      }),
      db.disputeResolution.count({
        where: {
          createdAt: { gte: since },
          trade: { OR: [{ userId }, { vendorId: userId }] },
        },
      }),
    ]);
    return raised + resolved;
  } catch (error) {
    if (options.failClosed) {
      throw new RiskDataUnavailableError('Unable to establish dispute history.', { query: 'escrowDispute.count+disputeResolution.count', err: error && error.message });
    }
    logger.warn({ err: error && error.message }, '[fraud] dispute history unavailable');
    return 0;
  }
}
async function _aggregateVolume(db, userId, type, windowSeconds, options = {}) {
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
  } catch (error) {
    // FAIL CLOSED: "we could not look" is not "nothing to see". Returning 0 here
    // let a failed query satisfy a risk check, so a database outage became
    // permission to move customer money.
    if (options.failClosed) {
      throw new RiskDataUnavailableError('Unable to establish cumulative volume.', { query: 'transactionHistory.findMany', err: error && error.message });
    }
    logger.warn({ err: error && error.message }, '[fraud] cumulative volume unavailable');
    return 0;
  }
}

async function _persistAssessment(db, tx, riskScore, triggered) {
  try {
    // ASSET-AWARE. amountUsdc is denominated in USDC and legacy consumers read
    // it as such, so a GHS amount must never land there: 5,000 GHS is not 5,000
    // dollars, and a USD total computed from this table would be wrong by the
    // FX rate. New rows carry the asset and the exact amount; the legacy column
    // keeps its old meaning for USDC and stays zero for anything else.
    const asset = String(tx.asset || 'USDC').toUpperCase();
    const isUsdc = asset === 'USDC';
    const exact = tx.amount || 0;
    await db.fraudAssessment.create({
      data: {
        userId: tx.userId,
        transactionType: tx.type,
        asset,
        amountExact: exact,
        amountUsdc: isUsdc ? exact : 0,
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
  parseExactPesewas,
  evaluate,
  // Exposed so the payout gate and the tests can prove the policy contract and
  // the typed failures without going through a full evaluation.
  resolveGhsAmountPolicy,
  RiskDataUnavailableError,
  GhsRiskPolicyError,
  checkVelocity,
  getRules,
  getAssessments,
  RULES,
};
