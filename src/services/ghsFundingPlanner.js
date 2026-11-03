'use strict';

/**
 * GHS FUNDING PLANNER (issue #389, Agent A) — explicit, previewable, and
 * quote-bound. NO money mutation happens here: a preview plans; only an
 * explicit user consent + a fresh, unexpired, owner-scoped, one-time quote
 * is CONSUMED inside the withdrawal transaction by
 * nativeGhsWithdrawalService.processNativeGhsWithdrawal.
 *
 * Direction: a customer needs `requiredGhs` out of the GHS wallet. Native GHS
 * covers whatever it covers; the residual shortfall may be funded from USDC at
 * the EXECUTABLE quote rate (never a display rate). A GHS-only request never
 * touches FX and never asks for a rate.
 */

const { Prisma } = require('@prisma/client');
const quotes = require('./transactionQuoteService');

// The persisted TransactionQuote.purpose CHECK constraint is a closed set
// ('deposit','usdc_purchase','withdrawal','local_wallet','savings_deposit',
// 'savings_withdrawal'). A shortfall conversion is a withdrawal-purpose
// quote — reusing that value keeps ONE quote authority and requires no
// constraint change. The funding intent is carried by quoteIdentity.
const QUOTE_PURPOSE = 'withdrawal';
const QUOTE_IDENTITY_KIND = 'ghs_shortfall_funding';

class GhsFundingPlannerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GhsFundingPlannerError';
    this.code = code || 'GHS_FUNDING_PLAN_INVALID';
  }
}

function toExactPesewa(value, field = 'amountGhs') {
  if (value === null || value === undefined || value === '') {
    throw new GhsFundingPlannerError(`${field} is required`, 'GHS_AMOUNT_REQUIRED');
  }
  let d;
  try {
    d = new Prisma.Decimal(String(value));
  } catch (_) {
    throw new GhsFundingPlannerError(`${field} is not a decimal amount`, 'GHS_AMOUNT_INVALID');
  }
  if (!d.isFinite() || d.lessThanOrEqualTo(0)) {
    throw new GhsFundingPlannerError(`${field} must be greater than zero`, 'GHS_AMOUNT_INVALID');
  }
  if (!d.equals(d.toDecimalPlaces(2))) {
    throw new GhsFundingPlannerError(
      `${field} must be an exact 2-dp GHS amount (pesewa precision)`,
      'GHS_AMOUNT_PRECISION'
    );
  }
  return d;
}

/**
 * Pure planning step. Returns what the payout WOULD need; performs no I/O.
 *
 * @param {object} input
 * @param {string|number} input.amountGhs       exact recipient GHS amount
 * @param {string|number} input.feeGhs          explicit fee (v1 policy: 0.00)
 * @param {string|number} input.availableNativeGhs customer's native GHS
 */
function planGhsPayoutFunding({ amountGhs, feeGhs = 0, availableNativeGhs = 0 }) {
  const recipient = toExactPesewa(amountGhs, 'amountGhs');
  const fee = feeGhs === 0 ? new Prisma.Decimal(0) : toExactPesewa(feeGhs, 'feeGhs');
  const required = recipient.plus(fee);
  let available;
  try {
    available = new Prisma.Decimal(String(availableNativeGhs ?? 0));
  } catch (_) {
    throw new GhsFundingPlannerError('availableNativeGhs is not a decimal amount', 'GHS_AMOUNT_INVALID');
  }
  if (available.isNegative()) available = new Prisma.Decimal(0);

  if (available.greaterThanOrEqualTo(required)) {
    return {
      mode: 'GHS_ONLY',
      recipientGhs: recipient.toFixed(2),
      feeGhs: fee.toFixed(2),
      requiredGhs: required.toFixed(2),
      availableNativeGhs: available.toFixed(2),
      shortfallGhs: '0.00',
      requiresQuote: false,
      usdcDebitRequired: false,
    };
  }

  const shortfall = required.minus(available);
  return {
    mode: 'QUOTE_REQUIRED',
    recipientGhs: recipient.toFixed(2),
    feeGhs: fee.toFixed(2),
    requiredGhs: required.toFixed(2),
    availableNativeGhs: available.toFixed(2),
    shortfallGhs: shortfall.toFixed(2),
    requiresQuote: true,
    usdcDebitRequired: true,
    // No rate is invented here: the executable rate arrives with the quote.
    disclosure: 'A fresh USDC→GHS quote is required to fund the shortfall. Nothing is converted until you explicitly consent to that quote.',
  };
}

/**
 * Mint the executable shortfall quote through the ONE canonical quote
 * authority (fresh-rate gated, owner-scoped, expiring, one-time). The quote's
 * usdcAmount is EXACTLY the USDC the customer pays for `shortfallGhs`.
 */
async function quoteGhsShortfall({ prisma, marketOracle, userId, shortfallGhs, ttlSeconds = undefined, now = new Date() }) {
  const shortfall = toExactPesewa(shortfallGhs, 'shortfallGhs');
  const quote = await quotes.createServerTransactionQuote({
    prisma,
    marketOracle,
    userId,
    purpose: QUOTE_PURPOSE,
    amountGhs: Number(shortfall.toFixed(2)),
    ttlSeconds,
    now,
    // §P.5-C identity is an opaque STRING token ([A-Za-z0-9_-:], 8-200).
    // It names the funding intent, not the economics (the quote carries those).
    quoteIdentity: `${QUOTE_IDENTITY_KIND}:${userId}:${shortfall.toFixed(2).replace('.', '')}:${new Date(now).getTime()}`,
  });
  return {
    quoteId: quote.id,
    purpose: QUOTE_PURPOSE,
    shortfallGhs: new Prisma.Decimal(quote.amountGhs).toFixed(2),
    usdcDebitExact: new Prisma.Decimal(quote.usdcAmount).toFixed(12),
    rateGhsPerUsdcExact: new Prisma.Decimal(quote.rateGhsPerUsdc).toFixed(8),
    rateAsOf: quote.rateAsOf,
    rateSource: quote.rateSource,
    expiresAt: quote.expiresAt,
    consentRequired: true,
  };
}

module.exports = {
  QUOTE_PURPOSE,
  QUOTE_IDENTITY_KIND,
  GhsFundingPlannerError,
  toExactPesewa,
  planGhsPayoutFunding,
  quoteGhsShortfall,
};
