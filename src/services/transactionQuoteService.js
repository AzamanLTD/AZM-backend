'use strict';

const crypto = require('crypto');
const { Prisma } = require('@prisma/client');

const {
    RATE_FRESHNESS_MAX_AGE_SECONDS,
    RATE_FRESHNESS_CLOCK_SKEW_ALLOWANCE_MS,
} = require('../config/rateFreshness');

// §P.5-C — durable quote identity. When a caller supplies an idempotency /
// request key, persistence is DB-ENFORCED (unique partial index), never a
// read-then-write check. Identical reuse REPLAYS the committed quote (same
// route decision, rate provenance, amounts and expiry — nothing recomputed);
// conflicting reuse fails closed.
class QuoteIdentityConflictError extends Error {
    constructor(message, existingQuote = null) {
        super(message);
        this.name = 'QuoteIdentityConflictError';
        this.code = 'QUOTE_IDENTITY_CONFLICT';
        this.statusCode = 409;
        this.quote = existingQuote;
    }
}

class QuoteIdentityReplayError extends QuoteIdentityConflictError {
    constructor(existingQuote) {
        super('Idempotency key already produced this exact quote — returning the committed quote');
        this.name = 'QuoteIdentityReplayError';
        this.code = 'QUOTE_IDENTITY_REPLAY';
        this.statusCode = 409; // surface-level replay is a caller decision
        this.quote = existingQuote;
    }
}

const DEFAULT_QUOTE_TTL_SECONDS = 60;
const MAX_RATE_GHS_PER_USDC = 1000000;
const MIN_RATE_GHS_PER_USDC = 0.000001;

function roundMoney(value) {
  // §P.5-C audit r13 (§6): the 2dp money normalization is EXACT decimal
  // HALF_UP — never a binary float multiply. Math.round((v + EPSILON) * 100)
  // silently changed valid sub-pesewa inputs at rounding ties (e.g. 41958.285
  // → 41958.28 instead of the exact HALF_UP 41958.29) and lost whole cents at
  // magnitudes where v * 100 exceeds the double-integer range. The public
  // shape stays a JS Number (presentation boundary); the EXACT 2dp decimal is
  // roundMoneyExact below — authoritative callers MUST use it.
  // accepts a number, numeric string or Decimal (the old formula coerced all
  // three); non-numeric garbage normalizes to NaN exactly like Math.round did.
  if (typeof value === 'number' && !Number.isFinite(value)) return value;
  try {
    return Number(roundMoneyExact(value));
  } catch (err) {
    return NaN;
  }
}

function roundMoneyExact(value) {
  // String(value) is the lossless shortest round-trip repr of the input
  // (double, string or Decimal) — parsed by Prisma's decimal.js with no
  // intermediate binary-float arithmetic, then projected ONCE at the 2dp
  // money authority with HALF_UP. The persisted quote can never silently
  // become a different Decimal than the contract rounded it to.
  return new Prisma.Decimal(String(value)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function createTransactionQuote({
  amountGhs, rateGhsPerUsdc, feeGhs = 0, ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
  now = new Date(), rateSource = 'AZM_ADMIN_MOCK', rateAsOf = now,
  id = crypto.randomUUID(), purpose = 'usdc_purchase', userId = null,
  // §P.5-C route-aware identity (all optional — legacy callers keep exact
  // prior behavior; unbound quotes persist candidates without a selection).
  routeIdentity = null, quoteIdentity = null,
  // §P.5-C Decimal-native rate path: optional authoritative exact rate
  // (Prisma Decimal / string from the DB). When present, ALL economics and
  // persistence use it — rateGhsPerUsdc (Number) remains only the
  // presentation-boundary projection for the legacy API shape.
  rateGhsPerUsdcExact = null,
}) {
  if (!Number.isFinite(amountGhs) || amountGhs <= 0) throw new Error('amountGhs must be greater than zero');
  if (!Number.isFinite(rateGhsPerUsdc) || rateGhsPerUsdc < MIN_RATE_GHS_PER_USDC || rateGhsPerUsdc > MAX_RATE_GHS_PER_USDC) throw new Error('rateGhsPerUsdc is outside the permitted range');
  if (rateGhsPerUsdcExact != null) {
    const exactRateCheck = new Prisma.Decimal(rateGhsPerUsdcExact);
    if (!exactRateCheck.isFinite() || exactRateCheck.lessThan(MIN_RATE_GHS_PER_USDC) || exactRateCheck.greaterThan(MAX_RATE_GHS_PER_USDC)) {
      throw new Error('rateGhsPerUsdc is outside the permitted range');
    }
  }
  if (!Number.isFinite(feeGhs) || feeGhs < 0) throw new Error('feeGhs must be zero or greater');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new Error('ttlSeconds must be between 1 and 900 seconds');
  if (!userId || !Number.isInteger(Number(userId))) throw new Error('userId is required');
  if (quoteIdentity !== null && (typeof quoteIdentity !== 'string' || !/^[-A-Za-z0-9_:]{8,200}$/.test(quoteIdentity))) {
    throw new Error('quoteIdentity must be 8-200 chars of [A-Za-z0-9_-:]');
  }
  const route = routeIdentity || {};
  if (route.selectedRoute !== undefined && route.selectedRoute !== null && typeof route.selectedRoute !== 'string') {
    throw new Error('routeIdentity.selectedRoute must be a string or null');
  }

  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);

  // §P.5-C exact quote arithmetic: a quote feeds authoritative customer
  // liability settlement, so its economics are computed with exact decimal
  // arithmetic (2dp GHS money, ≤8dp rate, exact 12dp HALF_UP USDC quotient)
  // instead of JS floating-point division. The public shape keeps JS
  // numbers; the exact 12dp string is carried for lossless persistence.
  // §P.5-C audit r13 (§6): the exact economics derive DIRECTLY from the
  // exact 2dp projection — the public Number fields below are projections OF
  // it, so the persisted _amountGhsExact and the returned amountGhs can never
  // disagree (the old String(roundMoney(v)) path re-floated the value).
  const amountExact = roundMoneyExact(amountGhs);
  const feeExact = roundMoneyExact(feeGhs);
  const netExact = amountExact.minus(feeExact).isNegative() ? new Prisma.Decimal(0) : amountExact.minus(feeExact);
  // §P.5-C Decimal-native rate: the authoritative Decimal representation is
  // used DIRECTLY — never reconstructed from a JS Number — so the persisted
  // _rateExact is exactly the DB-authoritative 8dp value.
  const rateExact = rateGhsPerUsdcExact != null
    ? new Prisma.Decimal(rateGhsPerUsdcExact)
    : new Prisma.Decimal(String(rateGhsPerUsdc));
  const usdcExact = netExact.div(rateExact).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);

  return {
    id,
    userId: Number(userId),
    purpose,
    amountGhs: Number(amountExact),
    feeGhs: Number(feeExact),
    netGhs: Number(netExact),
    rateGhsPerUsdc,
    usdcAmount: Number(usdcExact),
    rateSource,
    rateAsOf: new Date(rateAsOf).toISOString(),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    // §P.5-C durable route identity (never fabricated for legacy quotes)
    quoteIdentity: quoteIdentity || null,
    inputAsset: route.inputAsset !== undefined ? route.inputAsset : 'GHS',
    outputAsset: route.outputAsset !== undefined ? route.outputAsset : 'USDC',
    selectedRoute: route.selectedRoute || null,
    routeProviderRail: route.routeProviderRail || null,
    routePolicyVersion: route.routePolicyVersion || null,
    routeCandidates: route.routeCandidates || null,
    selectionProvenance: route.selectionProvenance || null,
    // exact strings used ONLY for lossless DECIMAL persistence
    _amountGhsExact: amountExact.toFixed(2),
    _feeGhsExact: feeExact.toFixed(2),
    _netGhsExact: netExact.toFixed(2),
    _rateExact: rateExact.toFixed(8),
    _usdcAmountExact: usdcExact.toFixed(12),
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
  // §P.5-C Decimal-native rate path: the rate stays a Prisma Decimal
  // (DB-native) end-to-end; JS Number is only a presentation-boundary
  // projection (`rateGhsPerUsdc`), never an input to authoritative
  // economics or persistence. `liveRetailRate` is canonical; the legacy
  // USD/GHS field is retained only as a compatibility fallback for older
  // installations that predate the explicit USDC retail-rate field.
  const retail = settings?.liveRetailRate != null ? new Prisma.Decimal(settings.liveRetailRate) : null;
  const legacy = settings?.liveUsdToGhs != null ? new Prisma.Decimal(settings.liveUsdToGhs) : null;
  const retailUsable = !!(retail && retail.isFinite() && retail.greaterThan(0));
  const rateExact = retailUsable
    ? retail
    : (legacy && legacy.isFinite() && legacy.greaterThan(0) ? legacy : null);

  if (!rateExact) {
    throw new Error('A current USDC/GHS rate is not available');
  }
  const rateGhsPerUsdc = rateExact.toNumber();

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
    rateGhsPerUsdcExact: rateExact,
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
    // §P.5-C Decimal-native rate path: the authoritative rate stays a Prisma
    // Decimal (DB-native) end-to-end — JS Number is only a
    // presentation-boundary projection, never an input to authoritative
    // economics or persistence. The 271C freshness semantics above
    // (lastExternalSync as the sole freshness authority) are unchanged.
    const retail = settings?.liveRetailRate != null ? new Prisma.Decimal(settings.liveRetailRate) : null;
    const legacy = settings?.liveUsdToGhs != null ? new Prisma.Decimal(settings.liveUsdToGhs) : null;
    const retailUsable = !!(retail && retail.isFinite() && retail.greaterThan(0));
    const rateExact = retailUsable
        ? retail
        : (legacy && legacy.isFinite() && legacy.greaterThan(0) ? legacy : null);
    if (!rateExact) {
        throw new RateUnavailableError(
            'Exchange rate is temporarily unavailable. Please retry shortly.',
            'RATE_UNAVAILABLE'
        );
    }
    const rateGhsPerUsdc = rateExact.toNumber();

    void marketOracle;
    return {
        rateGhsPerUsdc,
        rateGhsPerUsdcExact: rateExact,
        rateSource: settings?.liveRateSource || 'AZM_ADMIN_MOCK',
        // rateAsOf is the TRUE external observation that freshness was
        // enforced against — never a fabricated fallback timestamp.
        rateAsOf: new Date(observedMs),
        externalAgeSeconds,
        maxAgeSeconds: effectiveMaxAgeSeconds,
    };
}

function mapQuoteRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: Number(row.userId),
    purpose: row.purpose,
    amountGhs: Number(row.amountGhs),
    feeGhs: Number(row.feeGhs),
    netGhs: Number(row.netGhs),
    rateGhsPerUsdc: Number(row.rateGhsPerUsdc),
    usdcAmount: Number(row.usdcAmount),
    // §P.5-E audit r13 (§2): EXACT persisted-authority strings — additive to
    // the legacy Number projection. The Number fields are presentation only:
    // the quote's native usdcAmount is numeric(30,12) and Number() SILENTLY
    // destroys the 9th–12th decimals at magnitude (verified:
    // Number('67890123.123456789012') === 67890123.12345679). Authoritative
    // financial callers — TransactionHistory.amountUsdc, the balance credit,
    // the Model B quote binding — MUST consume these exact fields.
    amountGhsExact: new Prisma.Decimal(row.amountGhs).toFixed(2),
    feeGhsExact: new Prisma.Decimal(row.feeGhs).toFixed(2),
    netGhsExact: new Prisma.Decimal(row.netGhs).toFixed(2),
    rateGhsPerUsdcExact: new Prisma.Decimal(row.rateGhsPerUsdc).toFixed(8),
    usdcAmountExact: new Prisma.Decimal(row.usdcAmount).toFixed(12),
    rateSource: row.rateSource,
    rateAsOf: new Date(row.rateAsOf).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    consumedAt: row.consumedAt ? new Date(row.consumedAt).toISOString() : null,
    consumedFor: row.consumedFor,
    // §P.5-C durable route identity — historically absent columns stay null,
    // never fabricated
    quoteIdentity: row.quoteIdentity || null,
    inputAsset: row.inputAsset || null,
    outputAsset: row.outputAsset || null,
    selectedRoute: row.selectedRoute || null,
    routeProviderRail: row.routeProviderRail || null,
    routePolicyVersion: row.routePolicyVersion || null,
    routeCandidates: row.routeCandidates || null,
    selectionProvenance: row.selectionProvenance || null,
  };
}

// Fingerprint of the request economics an idempotency key protects. Replay
// is allowed ONLY for an identical fingerprint; anything else is a conflict.
function quoteIdentityFingerprint(quote) {
  return JSON.stringify({
    userId: Number(quote.userId),
    purpose: quote.purpose,
    amountGhs: new Prisma.Decimal(quote.amountGhs).toFixed(2),
    feeGhs: new Prisma.Decimal(quote.feeGhs).toFixed(2),
    inputAsset: quote.inputAsset || null,
    outputAsset: quote.outputAsset || null,
    selectedRoute: quote.selectedRoute || null,
    routeProviderRail: quote.routeProviderRail || null,
  });
}

async function persistTransactionQuote(prisma, quote) {
  if (!prisma?.$executeRaw) throw new Error('Quote service requires Prisma raw SQL support');

  try {
    await prisma.$executeRaw`
      INSERT INTO "TransactionQuote"
        ("id", "userId", "purpose", "amountGhs", "feeGhs", "netGhs",
         "rateGhsPerUsdc", "usdcAmount", "rateSource", "rateAsOf", "createdAt", "expiresAt",
         "quoteIdentity", "inputAsset", "outputAsset", "selectedRoute", "routeProviderRail",
         "routePolicyVersion", "routeCandidates", "selectionProvenance")
      VALUES
        (${quote.id}::uuid, ${quote.userId}, ${quote.purpose}, ${quote._amountGhsExact ?? quote.amountGhs}::numeric,
         ${quote._feeGhsExact ?? quote.feeGhs}::numeric, ${quote._netGhsExact ?? quote.netGhs}::numeric,
         ${quote._rateExact ?? String(quote.rateGhsPerUsdc)}::numeric, ${quote._usdcAmountExact ?? quote.usdcAmount}::numeric,
         ${quote.rateSource}, ${new Date(quote.rateAsOf)},
         ${new Date(quote.createdAt)}, ${new Date(quote.expiresAt)},
         ${quote.quoteIdentity || null}, ${quote.inputAsset || null}, ${quote.outputAsset || null},
         ${quote.selectedRoute || null}, ${quote.routeProviderRail || null},
         ${quote.routePolicyVersion || null}, ${quote.routeCandidates ? JSON.stringify(quote.routeCandidates) : null}::jsonb,
         ${quote.selectionProvenance || null})
    `;
  } catch (err) {
    // DB-ENFORCED quote identity: the unique partial index on quoteIdentity is
    // the ONLY authority (never a read-then-write pre-check). A unique
    // violation distinguishes replay from conflict by the stored fingerprint.
    // Raw $executeRaw failures surface as P2010 with the PostgreSQL error in
    // meta (code 23505 + constraint message) — P2002 is the client-API shape.
    const causeMessage = String(err?.meta?.message || '');
    const isQuoteIdentityUniqueViolation =
      (err?.code === 'P2002' && /quoteIdentity/i.test(String(err?.meta?.target || '') + causeMessage)) ||
      (err?.code === 'P2010' && err?.meta?.code === '23505' && /quoteIdentity/i.test(causeMessage)) ||
      /unique constraint.*TransactionQuote_quoteIdentity|unique_violation.*quoteIdentity/i.test(String(err?.message || ''));
    const isUniqueViolation = isQuoteIdentityUniqueViolation;
    if (quote.quoteIdentity && isUniqueViolation) {
      let existing = null;
      try {
        const rows = await prisma.$queryRaw`
          SELECT "id", "userId", "purpose", "amountGhs", "feeGhs", "netGhs", "rateGhsPerUsdc", "usdcAmount",
                 "rateSource", "rateAsOf", "createdAt", "expiresAt", "consumedAt", "consumedFor",
                 "quoteIdentity", "inputAsset", "outputAsset", "selectedRoute", "routeProviderRail",
                 "routePolicyVersion", "routeCandidates", "selectionProvenance"
          FROM "TransactionQuote" WHERE "quoteIdentity" = ${quote.quoteIdentity} AND "userId" = ${quote.userId} LIMIT 1`;
        existing = rows.length ? mapQuoteRow(rows[0]) : null;
      } catch (fetchErr) {
        void fetchErr; // e.g. the enclosing caller-transaction is already aborted — fail closed below
      }
      if (!existing) throw new QuoteIdentityConflictError('Idempotency key is already in use');
      if (quoteIdentityFingerprint(existing) !== quoteIdentityFingerprint(quote)) {
        throw new QuoteIdentityConflictError('Idempotency key was reused with a different quote request', existing);
      }
      throw new QuoteIdentityReplayError(existing);
    }
    throw err;
  }

  return quote;
}

async function createServerTransactionQuote({ prisma, marketOracle, userId, purpose, amountGhs, feeGhs = 0, ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS, now = new Date(), maxAgeSeconds, routeIdentity = null, quoteIdentity = null }) {
  // 271C fail-closed gate: EVERY fiat DEPOSIT quote created through this
  // helper must pass the canonical lastExternalSync freshness gate. This
  // includes the mounted generic fiat initiation route and the /api/quotes
  // endpoint. Non-deposit quote purposes are deliberately NOT gated in this
  // stage (issue #271 staging).
  const rate = purpose === 'deposit'
    ? await getFreshServerRateGhsPerUsdc({ prisma, marketOracle, now, maxAgeSeconds })
    : await getServerRateGhsPerUsdc({ prisma, marketOracle });
  const quote = createTransactionQuote({ userId, purpose, amountGhs, rateGhsPerUsdc: rate.rateGhsPerUsdc, rateGhsPerUsdcExact: rate.rateGhsPerUsdcExact, rateSource: rate.rateSource, rateAsOf: rate.rateAsOf, feeGhs, ttlSeconds, now, routeIdentity, quoteIdentity });
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
              "createdAt", "expiresAt", "consumedAt", "consumedFor",
              "quoteIdentity", "inputAsset", "outputAsset", "selectedRoute",
              "routeProviderRail", "routePolicyVersion", "routeCandidates", "selectionProvenance"
  `;

  if (!rows.length) throw new Error('Transaction quote is invalid, expired, already consumed, or not owned by this user');

  // §P.5-C: consumption returns the FULL route identity so downstream
  // settlement can never lose it, and candidate/provenance evidence survives.
  return mapQuoteRow(rows[0]);
}

// §P.5-E authority binding: read-only exact fetch of a PERSISTED quote.
// Returns EXACT numeric strings straight from PostgreSQL — never Number()
// projections — so settlement can require exact Decimal equality against
// what was actually persisted. The quote row is the ONLY quote authority.
async function getPersistedTransactionQuoteExact({ prisma, quoteId }) {
  if (!prisma?.$queryRaw) throw new Error('Quote service requires Prisma raw SQL support');
  if (typeof quoteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(quoteId)) return null;
  const rows = await prisma.$queryRaw`
    SELECT "id"::text AS "id", "userId", "purpose",
           "amountGhs"::text AS "amountGhs", "feeGhs"::text AS "feeGhs", "netGhs"::text AS "netGhs",
           "rateGhsPerUsdc"::text AS "rateGhsPerUsdc", "usdcAmount"::text AS "usdcAmount",
           "consumedAt", "consumedFor",
           "selectedRoute", "routeProviderRail", "routePolicyVersion"
    FROM "TransactionQuote" WHERE "id" = ${quoteId}::uuid LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    userId: Number(r.userId),
    purpose: r.purpose,
    amountGhs: r.amountGhs,
    feeGhs: r.feeGhs,
    netGhs: r.netGhs,
    rateGhsPerUsdc: r.rateGhsPerUsdc,
    usdcAmount: r.usdcAmount,
    consumedAt: r.consumedAt ? new Date(r.consumedAt).toISOString() : null,
    consumedFor: r.consumedFor || null,
    selectedRoute: r.selectedRoute || null,
    routeProviderRail: r.routeProviderRail || null,
    routePolicyVersion: r.routePolicyVersion || null,
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
  QuoteIdentityConflictError,
  QuoteIdentityReplayError,
  assertQuoteActive,
  roundMoney,
  roundMoneyExact,
  getPersistedTransactionQuoteExact,
};
