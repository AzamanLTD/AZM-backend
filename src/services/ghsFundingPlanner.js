'use strict';

/**
 * GHS FUNDING PLANNER (issue #389, withdrawal workstream) — explicit, previewable, and
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
const { destinationIdentityOf, payoutIntentDigest } = require('./payoutIntent');

// The persisted TransactionQuote.purpose CHECK constraint is a closed set
// ('deposit','usdc_purchase','withdrawal','local_wallet','savings_deposit',
// 'savings_withdrawal'). A shortfall conversion is a withdrawal-purpose
// quote — reusing that value keeps ONE quote authority and requires no
// constraint change. The funding intent is carried by quoteIdentity.
const SHORTFALL_ROUTE = 'USDC_TO_GHS_SHORTFALL';
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
  // A ZERO FEE IS A POLICY, NOT A MISSING VALUE. The amount validator refuses
  // zero (a payout of nothing is not a payout), so a zero fee must be
  // recognized here as exact zero rather than pushed through it.
  const feeIsZero = feeGhs === 0 || feeGhs === '0' || feeGhs === '0.0' || feeGhs === '0.00'
    || (feeGhs !== null && feeGhs !== undefined && feeGhs !== '' && String(Number(feeGhs)) === '0');
  const fee = feeIsZero ? new Prisma.Decimal(0) : toExactPesewa(feeGhs, 'feeGhs');
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
async function quoteGhsShortfall({ prisma, marketOracle, userId, shortfallGhs, intent, ttlSeconds = undefined, now = new Date() }) {
  const shortfall = toExactPesewa(shortfallGhs, 'shortfallGhs');
  // §P1-2 A CONSENT NAMES ITS PAYOUT. Without an intent this quote would be a
  // promise to fund *some* payout with this shortfall; refuse to mint one.
  if (!intent || !intent.rail || intent.recipientGhs === undefined || intent.recipientGhs === null) {
    throw new Error('quoteGhsShortfall requires the payout intent (rail, recipientGhs, destinationIdentity) it funds');
  }
  const intentDigest = payoutIntentDigest(intent);
  const quote = await quotes.createServerTransactionQuote({
    prisma,
    marketOracle,
    userId,
    purpose: QUOTE_PURPOSE,
    amountGhs: Number(shortfall.toFixed(2)),
    ttlSeconds,
    now,
    // §5.1 DIRECTION: the default quote route identity is GHS-in/USDC-out (the
    // deposit direction). A shortfall funding quote is the OPPOSITE: the
    // customer pays USDC and receives GHS. Persisting the wrong direction
    // would let a settlement path read the rate backwards.
    routeIdentity: {
      inputAsset: 'USDC',
      outputAsset: 'GHS',
      selectedRoute: SHORTFALL_ROUTE,
    },
    // §P.5-C identity is an opaque STRING token ([A-Za-z0-9_-:], 8-200).
    // It names the funding intent, not the economics (the quote carries those).
    // The token carries the intent digest. Mint and consume both derive it with
    // payoutIntent.destinationIdentityOf/payoutIntentDigest, so "the payout this
    // quote funds" is a checkable fact rather than a convention.
    quoteIdentity: `${QUOTE_IDENTITY_KIND}:${userId}:${shortfall.toFixed(2).replace('.', '')}:${intentDigest}:${new Date(now).getTime()}`,
  });
  // §5.4 DISCLOSURE: the quote's stored USDC amount is an exact 12dp quotient
  // (theoretical). The USDC liability authority debits 8dp. The number the
  // customer accepts must BE the number that is debited, so the executable
  // quote discloses the final 8dp debit, and the theoretical quotient is kept
  // alongside it as evidence, never as the price.
  const theoretical12 = new Prisma.Decimal(quote.usdcAmount);
  const actualDebit8 = theoretical12.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  return {
    quoteId: quote.id,
    purpose: QUOTE_PURPOSE,
    shortfallGhs: new Prisma.Decimal(quote.amountGhs).toFixed(2),
    usdcDebit: actualDebit8.toFixed(8),
    usdcDebitExact: actualDebit8.toFixed(8),
    usdcDebitTheoretical: theoretical12.toFixed(12),
    roundingPolicy: 'USDC debit is the exact 12dp quotient rounded HALF_UP once to the 8dp ledger scale; the disclosed usdcDebit is the amount debited.',
    rateGhsPerUsdcExact: new Prisma.Decimal(quote.rateGhsPerUsdc).toFixed(8),
    routeIdentity: { inputAsset: 'USDC', outputAsset: 'GHS', selectedRoute: SHORTFALL_ROUTE },
    rateAsOf: quote.rateAsOf,
    rateSource: quote.rateSource,
    expiresAt: quote.expiresAt,
    intent: {
      rail: String(intent.rail || 'MOMO').toUpperCase(),
      recipientGhs: new Prisma.Decimal(intent.recipientGhs).toFixed(2),
      feeGhs: new Prisma.Decimal(intent.feeGhs ?? 0).toFixed(2),
      destinationIdentity: intent.destinationIdentity ?? null,
      digest: intentDigest,
    },
    consentRequired: true,
  };
}

module.exports = {
  SHORTFALL_ROUTE,
  QUOTE_PURPOSE,
  QUOTE_IDENTITY_KIND,
  GhsFundingPlannerError,
  toExactPesewa,
  destinationIdentityOf,
  payoutIntentDigest,
  planGhsPayoutFunding,
  quoteGhsShortfall,
};
