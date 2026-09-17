'use strict';

const crypto = require('crypto');

const {
    RATE_FRESHNESS_MAX_AGE_SECONDS,
    RATE_FRESHNESS_CLOCK_SKEW_ALLOWANCE_MS,
} = require('../config/rateFreshness');

const DEFAULT_QUOTE_TTL_SECONDS = 60;
const MAX_RATE_GHS_PER_USDC = 1000000;
const MIN_RATE_GHS_PER_USDC = 0.000001;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function createTransactionQuote({ amountGhs, rateGhsPerUsdc, feeGhs = 0, ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS, now = new Date(), rateSource = 'AZM_ADMIN_MOCK', rateAsOf = now, id = crypto.randomUUID(), purpose = 'usdc_purchase', userId = null }) {
  if (!Number.isFinite(amountGhs) || amountGhs <= 0) throw new Error('amountGhs must be greater than zero');
  if (!Number.isFinite(rateGhsPerUsdc) || rateGhsPerUsdc < MIN_RATE_GHS_PER_USDC || rateGhsPerUsdc > MAX_RATE_GHS_PER_USDC) throw new Error('rateGhsPerUsdc is outside the permitted range');
  if (!Number.isFinite(feeGhs) || feeGhs < 0) throw new Error('feeGhs must be zero or greater');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new Error('ttlSeconds must be between 1 and 900 seconds');
  if (!userId || !Number.isInteger(Number(userId))) throw new Error('userId is required');

  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  const netGhs = Math.max(0, amountGhs - feeGhs);

  return {
    id,
    userId: Number(userId),
    purpose,
    amountGhs: roundMoney(amountGhs),
    feeGhs: roundMoney(feeGhs),
    netGhs: roundMoney(netGhs),
    rateGhsPerUsdc,
    usdcAmount: netGhs / rateGhsPerUsdc,
    rateSource,
    rateAsOf: new Date(rateAsOf).toISOString(),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function getServerRateGhsPerUsdc({ prisma, marketOracle }) {
  if (!prisma) throw new Error('Quote service requires Prisma');

  const settings = await prisma.globalSettings.findUnique({
    where: { id: 1 },
    select: { liveRetailRate: true, liveUsdToGhs: true, liveRateSource: true, lastRateSync: true, lastExternalSync: true },
  });

  // `liveRetailRate` is the canonical user-facing USDC/GHS rate. The legacy
  // USD/GHS field is retained only as a compatibility fallback for older
  // installations that predate the explicit USDC retail-rate field.
  const retailRate = Number(settings?.liveRetailRate);
  const legacyRate = Number(settings?.liveUsdToGhs);
  const rateGhsPerUsdc = Number.isFinite(retailRate) && retailRate > 0 ? retailRate : legacyRate;

  if (!Number.isFinite(rateGhsPerUsdc) || rateGhsPerUsdc <= 0) {
    throw new Error('A current USDC/GHS rate is not available');
  }

  void marketOracle;
  // Snapshot the TRUE external observation timestamp (issue #271 / PR 271B):
  // a newly-created quote's rateAsOf must never inherit a timestamp
  // fabricated by the MOCK echo or a manual admin update. Post-271B writers
  // keep lastRateSync === lastExternalSync for the same genuine observation;
  // the lastExternalSync-preferred read is what guarantees the snapshot stops
  // inheriting echo/admin stamps even while lastRateSync remains readable for
  // staged-rollout compatibility. Rows that predate 271B honestly keep
  // lastExternalSync = NULL and fall back to the legacy field rather than
  // fabricating a fresh timestamp; the final new Date() guard only covers a
  // GlobalSettings row with no recorded history at all (rateAsOf is NOT NULL).
  return {
    rateGhsPerUsdc,
    rateSource: settings?.liveRateSource || 'AZM_ADMIN_MOCK',
    rateAsOf: settings?.lastExternalSync || settings?.lastRateSync || new Date(),
  };
}

// =============================================================================
// 271C fail-closed stale-rate gate (issue #271)
//
// A new fiat deposit quote may be created ONLY when the most recent EXTERNAL
// market-rate observation is fresh:
//
//     lastExternalSync IS NOT NULL
//   AND now - lastExternalSync <= RATE_FRESHNESS_MAX_AGE_SECONDS
//   AND liveRetailRate is finite and > 0
//
// Anything else is stale/untrusted and throws RateUnavailableError (503):
//   - NULL or invalid lastExternalSync  -> RATE_UNAVAILABLE
//   - future lastExternalSync (beyond the tiny clock-skew allowance) -> RATE_STALE
//   - age above the configured maximum -> RATE_STALE
//   - invalid/non-positive retail rate -> RATE_UNAVAILABLE
//
// A manual admin override (lastAdminSetAt) and a MOCK gateway echo
// (lastEchoAt) never refresh freshness, and the legacy lastRateSync field is
// deliberately NOT consulted — the gate fails closed on the canonical
// lastExternalSync timestamp alone.
// =============================================================================

class RateUnavailableError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'RateUnavailableError';
        this.code = code; // 'RATE_STALE' | 'RATE_UNAVAILABLE'
        this.statusCode = 503;
    }
}

async function getFreshServerRateGhsPerUsdc({ prisma, marketOracle, now = new Date(), maxAgeSeconds } = {}) {
    if (!prisma) throw new Error('Quote service requires Prisma');

    const settings = await prisma.globalSettings.findUnique({
        where: { id: 1 },
        select: {
            liveRetailRate: true,
            liveUsdToGhs: true,
            liveRateSource: true,
            lastExternalSync: true,
        },
    });

    // Freshness is evaluated FIRST and exclusively on the canonical external
    // observation timestamp. lastRateSync / lastAdminSetAt / lastEchoAt are
    // never consulted here.
    const observedMs = settings?.lastExternalSync ? new Date(settings.lastExternalSync).getTime() : NaN;
    if (!Number.isFinite(observedMs)) {
        // NULL, missing, or an unparseable timestamp — the rate has no
        // trustworthy external provenance.
        throw new RateUnavailableError(
            'Exchange rate is temporarily unavailable. Please retry shortly.',
            'RATE_UNAVAILABLE'
        );
    }

    const nowMs = new Date(now).getTime();
    if (observedMs > nowMs + RATE_FRESHNESS_CLOCK_SKEW_ALLOWANCE_MS) {
        // An external observation from the future is untrusted, never
        // "infinitely fresh".
        throw new RateUnavailableError(
            'Exchange rate is temporarily unavailable. Please retry shortly.',
            'RATE_STALE'
        );
    }

    const effectiveMaxAgeSeconds = Number.isFinite(maxAgeSeconds)
        ? maxAgeSeconds
        : RATE_FRESHNESS_MAX_AGE_SECONDS;

    // Boundary contract: age <= maxAge is acceptable, age > maxAge is stale.
    const externalAgeSeconds = (nowMs - observedMs) / 1000;
    if (externalAgeSeconds > effectiveMaxAgeSeconds) {
        throw new RateUnavailableError(
            'Exchange rate is temporarily unavailable. Please retry shortly.',
            'RATE_STALE'
        );
    }

    // Rate resolution is identical to the ungated legacy reader: the canonical
    // liveRetailRate with the legacy USD/GHS field as a compatibility fallback
    // for installations that predate the explicit USDC retail-rate field.
    const retailRate = Number(settings?.liveRetailRate);
    const legacyRate = Number(settings?.liveUsdToGhs);
    const rateGhsPerUsdc = Number.isFinite(retailRate) && retailRate > 0 ? retailRate : legacyRate;
    if (!Number.isFinite(rateGhsPerUsdc) || rateGhsPerUsdc <= 0) {
        throw new RateUnavailableError(
            'Exchange rate is temporarily unavailable. Please retry shortly.',
            'RATE_UNAVAILABLE'
        );
    }

    void marketOracle;
    return {
        rateGhsPerUsdc,
        rateSource: settings?.liveRateSource || 'AZM_ADMIN_MOCK',
        // rateAsOf is the TRUE external observation that freshness was
        // enforced against — never a fabricated fallback timestamp.
        rateAsOf: new Date(observedMs),
        externalAgeSeconds,
        maxAgeSeconds: effectiveMaxAgeSeconds,
    };
}

async function persistTransactionQuote(prisma, quote) {
  if (!prisma?.$executeRaw) throw new Error('Quote service requires Prisma raw SQL support');

  await prisma.$executeRaw`
    INSERT INTO "TransactionQuote"
      ("id", "userId", "purpose", "amountGhs", "feeGhs", "netGhs",
       "rateGhsPerUsdc", "usdcAmount", "rateSource", "rateAsOf", "createdAt", "expiresAt")
    VALUES
      (${quote.id}::uuid, ${quote.userId}, ${quote.purpose}, ${quote.amountGhs}, ${quote.feeGhs}, ${quote.netGhs},
       ${quote.rateGhsPerUsdc}, ${quote.usdcAmount}, ${quote.rateSource}, ${new Date(quote.rateAsOf)},
       ${new Date(quote.createdAt)}, ${new Date(quote.expiresAt)})
  `;

  return quote;
}

async function createServerTransactionQuote({ prisma, marketOracle, userId, purpose, amountGhs, feeGhs = 0, ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS, now = new Date(), maxAgeSeconds }) {
  // 271C fail-closed gate: EVERY fiat DEPOSIT quote created through this
  // helper must pass the canonical lastExternalSync freshness gate. This
  // includes the mounted generic fiat initiation route and the /api/quotes
  // endpoint. Non-deposit quote purposes are deliberately NOT gated in this
  // stage (issue #271 staging).
  const rate = purpose === 'deposit'
    ? await getFreshServerRateGhsPerUsdc({ prisma, marketOracle, now, maxAgeSeconds })
    : await getServerRateGhsPerUsdc({ prisma, marketOracle });
  const quote = createTransactionQuote({ userId, purpose, amountGhs, rateGhsPerUsdc: rate.rateGhsPerUsdc, rateSource: rate.rateSource, rateAsOf: rate.rateAsOf, feeGhs, ttlSeconds, now });
  return persistTransactionQuote(prisma, quote);
}

async function consumeTransactionQuote({ prisma, quoteId, userId, purpose, now = new Date() }) {
  if (!prisma?.$queryRaw) throw new Error('Quote service requires Prisma raw SQL support');
  if (!quoteId || !userId || !Number.isInteger(Number(userId))) throw new Error('quoteId and userId are required');

  const rows = await prisma.$queryRaw`
    UPDATE "TransactionQuote"
    SET "consumedAt" = ${new Date(now)}, "consumedFor" = ${purpose || null}
    WHERE "id" = ${quoteId}::uuid
      AND "userId" = ${Number(userId)}
      AND (${purpose || null}::text IS NULL OR "purpose" = ${purpose})
      AND "consumedAt" IS NULL
      AND "expiresAt" > ${new Date(now)}
    RETURNING "id", "userId", "purpose", "amountGhs", "feeGhs", "netGhs",
              "rateGhsPerUsdc", "usdcAmount", "rateSource", "rateAsOf",
              "createdAt", "expiresAt", "consumedAt", "consumedFor"
  `;

  if (!rows.length) throw new Error('Transaction quote is invalid, expired, already consumed, or not owned by this user');

  const row = rows[0];
  return {
    id: row.id,
    userId: Number(row.userId),
    purpose: row.purpose,
    amountGhs: Number(row.amountGhs),
    feeGhs: Number(row.feeGhs),
    netGhs: Number(row.netGhs),
    rateGhsPerUsdc: Number(row.rateGhsPerUsdc),
    usdcAmount: Number(row.usdcAmount),
    rateSource: row.rateSource,
    rateAsOf: new Date(row.rateAsOf).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    consumedAt: new Date(row.consumedAt).toISOString(),
    consumedFor: row.consumedFor,
  };
}

function assertQuoteActive(quote, now = new Date()) {
  if (!quote || !quote.id || !quote.expiresAt) throw new Error('Invalid transaction quote');
  if (new Date(now).getTime() >= new Date(quote.expiresAt).getTime()) throw new Error('Transaction quote has expired');
  return quote;
}

module.exports = {
  DEFAULT_QUOTE_TTL_SECONDS,
  createTransactionQuote,
  createServerTransactionQuote,
  persistTransactionQuote,
  consumeTransactionQuote,
  getServerRateGhsPerUsdc,
  getFreshServerRateGhsPerUsdc,
  RateUnavailableError,
  assertQuoteActive,
  roundMoney,
};
