// services/ledgerService.js
// =============================================================================
// §P.4 — CANONICAL AUTHORITATIVE LIABILITY LEDGER SERVICE
//
// ONE accounting truth. JournalEntry remains the posting-line model; this
// service makes it AUTHORITATIVE by enforcing:
//   • CALLER-OWNED transaction: ledgerService.post(tx, params) requires the
//     caller's Prisma transaction client and NEVER opens its own DB
//     transaction underneath a financial mutation. A posting failure throws
//     and therefore rolls back the entire enclosing financial transaction.
//     There is no swallowed accounting exception on any path.
//   • EXACT quantities: Prisma.Decimal / exact decimal strings ONLY. JS
//     floating-point values, NaN, Infinity, negative or over-precision
//     quantities are REJECTED — never epsilon-compared.
//   • EXACT balancing: sum(debits) === sum(credits) in Decimal arithmetic;
//     zero-value postings and zero-value lines are rejected.
//   • ONE durable economic identity: a LedgerTransaction posting group with a
//     UNIQUE idempotencyKey. Exact replay returns the already-committed
//     result (postingHash proof). Duplicate CONCURRENT execution collides on
//     the unique index — the loser's enclosing transaction rolls back; a
//     second economic posting is impossible.
//   • ACCOUNT SEMANTICS (correct liability model — NOT the legacy asset
//     interpretation of user:{id}:available):
//       customer receives USDC      → C user:{id}:liability   (liability up)
//       customer returns/is owed less → D user:{id}:liability
//       custody assets             → normal DEBIT (D increases, C decreases)
//       restricted:reserves        — restricted obligations held for pending
//                                    external operations; released on
//                                    settlement, NEVER auto-refunded
//       clearing:conversion        — temporary conversion clearing (§P.5
//                                    inventory economics is NOT invented here)
//       revenue:fees               — realized fee revenue ONLY
//   • FAIL-CLOSED catalog: an account code that is not canonical nor a
//     recognized dynamic pattern is rejected — unknown accounts can never
//     silently absorb value.
//   • §P.5-A ASSET IDENTITY: mixing assets is rejected (1200 GHS ≠ 100 USDC even
//     when columns sum equal); cross-asset exchange is ONLY an explicit ASSET_CONVERSION.
//
// The legacy journalService.record()/journalIntegration helpers remain ONLY
// as non-authoritative compatibility for callers not yet migrated (§P.4
// wave 2). Migrated financial paths MUST use this primitive.
// =============================================================================

const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const logger = require('../src/config/logger');

// ── Account grammar ─────────────────────────────────────────────────────────
// Dynamic per-customer restricted-bucket accounts — each is the authoritative
// counterpart of a User projection column, so reconciliation can prove exact
// per-user equality for EVERY bucket, not just availableBalance:
//   user:{id}:liability      ↔ User.availableBalance
//   escrow:{key}:locked      ↔ User.escrowLockedBalance   (per-escrow holding; LedgerAccount.userId attributes ownership)
//   user:{id}:dispute        ↔ User.disputeEscrowBalance  (per-user dispute-locked)
//   user:{id}:unallocated    ↔ User.vendorUnallocatedBalance (per-vendor pool)
const USER_LIABILITY_RE = /^user:(\d+):liability$/;
const USER_DISPUTE_RE = /^user:(\d+):dispute$/;
const USER_UNALLOCATED_RE = /^user:(\d+):unallocated$/;
const ESCROW_LOCKED_RE = /^escrow:([A-Za-z0-9][A-Za-z0-9_.-]*):locked$/;

// Canonical chart of accounts. accountClass + normalSide + asset identity.
// §P.5 economics (inventory lots, pnl:inventory realized cost, GHS liquidity
// state machine) are deliberately NOT invented here — the accounts exist as
// catalog entries only and remain unused until their waves.
const CANONICAL_ACCOUNTS = {
  'custody:deposit:usdc':   { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: 'POLYGON' },
  'custody:hot:usdc':       { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: 'POLYGON' },
  'custody:cold:usdc':      { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: 'POLYGON' },
  'custody:exchange:usdc':  { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: 'POLYGON' },
  // canonical architecture: provider custody is a USDC ASSET LOCATION —
  // real USDC held by a payout/custody provider. The fiat GHS off-ramp rail
  // is NOT a USDC transfer and must never post here (it settles through
  // clearing:fiat:offramp:usdc until the GHS-liquidity wave models the
  // provider relationship).
  'custody:provider:usdc':  { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: null },
  // provisional custody clearing — webhook-observed deposits that carry a
  // customer credit but are NOT yet verified by independent transaction
  // evidence. NOT a PoR reserve asset (assetClass CLEARING is excluded from
  // the reserve computation); reclassified to custody:deposit:usdc exactly
  // once when Tatum evidence verifies the movement, or to the rejected
  // suspense when evidence definitively fails.
  'clearing:custody:unverified:usdc': { accountClass: 'CLEARING', normalSide: 'DEBIT', asset: 'USDC', network: 'POLYGON' },
  // definitive rejected/mismatched deposit exposure — customer credit was
  // already granted; real custody was never verified. Retained as an explicit
  // suspense state so the books can never pretend custody exists; reversal is
  // an auditable ops decision, never automatic.
  'clearing:custody:rejected:usdc':  { accountClass: 'CLEARING', normalSide: 'DEBIT', asset: 'USDC', network: 'POLYGON' },
  // GHS off-ramp settlement rail clearing — principal released on provider
  // SUCCESS pending the §P.5 GHS-liquidity wave, which will reconcile this
  // balance against actual fiat asset movements. This is NOT provider USDC
  // custody: no USDC balance at a provider is represented by this rail. The
  // rail is CREDIT-normal: its positive balance is the OUTSTANDING value
  // handed to the fiat rail awaiting GHS-side reconciliation (§P.5 debits
  // it when the fiat asset movement is confirmed). The settlement entry
  // credits the rail because the USDC-side liability was already released —
  // nothing in the current accounting perimeter funds a rail DEBIT, and the
  // GHS asset movements are deliberately unmodelled until §P.5.
  'clearing:fiat:offramp:usdc':      { accountClass: 'CLEARING', normalSide: 'CREDIT', asset: 'USDC', network: null },
  'fiat:momo:ghs':          { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'GHS',  network: null },
  'inventory:usdc:lots':    { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'restricted:reserves':   { accountClass: 'RESTRICTED', normalSide: 'CREDIT', asset: 'USDC', network: null },
  'clearing:conversion':    { accountClass: 'CLEARING',   normalSide: 'DEBIT',  asset: 'USDC', network: null },  // debit-side accumulation of fiat-settled conversions pending §P.5
  // AZM/USDC order-book reserve pool — USDC withheld by the matching engine
  // while BUY orders rest (limit/market). Credited at placement, drained at
  // match settlement and cancellation refunds. The order book does NOT touch
  // the user-escrow projection columns, so this is a platform clearing pool,
  // never a user-attributed escrow bucket. Any never-refunded resting-reserve
  // remainder stays visible here as an explicit balance.
  'clearing:orderbook:usdc': { accountClass: 'CLEARING',   normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'revenue:fees':           { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'revenue:spread':         { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'expense:gas':            { accountClass: 'EXPENSE',    normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'expense:provider':       { accountClass: 'EXPENSE',    normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'pnl:inventory':          { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  // §P.5-E: realized cost of inventory DELIVERED at Model B settlement —
  // debited with the exact USDC quantity of the consumed inventory lots at
  // the moment the customer settlement commits. Quantity-exact, never
  // rate-restated: the GHS-denominated margin lives in the durable
  // ModelBSettlement record (cost basis + customer spread), not here.
  'expense:cogs:usdc':      { accountClass: 'EXPENSE',    normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'pnl:arbitrage':          { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'equity:treasury':        { accountClass: 'EQUITY',     normalSide: 'CREDIT', asset: 'USDC', network: null },
  // §P.5-A: GHS-side equity counterpart of equity:treasury — CATALOG-ONLY until §P.5-D/E; never a GHS liability/spread/P&L.
  'equity:treasury:ghs':    { accountClass: 'EQUITY',     normalSide: 'CREDIT', asset: 'GHS',  network: null },
};

const ENTRY_TYPES = new Set([
  'DEPOSIT', 'WITHDRAWAL', 'TRADE', 'TRANSFER', 'ESCROW_LOCK', 'ESCROW_RELEASE',
  'ESCROW_REFUND', 'VAULT_DEPOSIT', 'VAULT_RELEASE', 'SUSU_CONTRIBUTION',
  'SUSU_PAYOUT', 'FEE', 'REWARD', 'ADJUSTMENT', 'BUSINESS_PAYMENT',
  'CUSTODY_DEPOSIT', 'CUSTODY_SWEEP', 'CUSTODY_WITHDRAWAL',
  'SHARED_VAULT_DEPOSIT', 'SHARED_VAULT_REFUND',
  'ESCROW_DISPUTE', 'SUSU_SEIZURE', 'SUSU_REFUND',
  'VENDOR_TOPUP', 'VENDOR_ALLOCATE',
  'CUSTODY_VERIFICATION', 'CUSTODY_REJECTION',
  'ASSET_CONVERSION', // §P.5-A: explicit cross-asset exchange identity ONLY
  'INVENTORY_ACQUISITION', // §P.5-B: USDC lot acquisition (single-asset USDC)
]);

// Exact-decimal string: non-negative, ≤ 8 decimal places, no exponent.
const EXACT_DECIMAL_RE = /^\d+(\.\d{1,8})?$/;

class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details) this.details = details;
  }
}

/**
 * Convert a monetary quantity to an EXACT Prisma.Decimal.
 * Accepted: Prisma.Decimal, exact decimal string, safe-integer JS number, or
 * a non-integer JS number whose shortest round-trip string form is an exact
 * ≤8dp decimal (String(float) round-trips the caller's intended decimal).
 * Rejected: negatives, over-precision, scientific notation, NaN, Infinity,
 * arbitrary strings, fractional floats with >8 significant decimals.
 */
function toExactDecimal(value, label = 'amount') {
  if (value instanceof Prisma.Decimal) {
    if (!value.isFinite()) throw new LedgerError('LEDGER_INEXACT_QUANTITY', `${label}: non-finite Decimal`);
    if (value.isNegative()) throw new LedgerError('LEDGER_NEGATIVE_QUANTITY', `${label}: negative quantities are rejected`);
    if (value.decimalPlaces() > 8) throw new LedgerError('LEDGER_INEXACT_QUANTITY', `${label}: more than 8 decimal places`);
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!EXACT_DECIMAL_RE.test(trimmed)) {
      throw new LedgerError('LEDGER_INEXACT_QUANTITY',
        `${label}: "${value}" is not an exact non-negative decimal string (<= 8 decimals, no exponent)`);
    }
    return new Prisma.Decimal(trimmed);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LedgerError('LEDGER_INEXACT_QUANTITY', `${label}: non-finite number`);
    if (value < 0) throw new LedgerError('LEDGER_NEGATIVE_QUANTITY', `${label}: negative quantities are rejected`);
    if (Number.isSafeInteger(value)) return new Prisma.Decimal(value);
    // Fractional float: accept ONLY its exact shortest round-trip string form
    // (this is the same value Prisma persists for the float projection
    // increment, so ledger and projection can never disagree).
    const s = String(value);
    if (EXACT_DECIMAL_RE.test(s)) return new Prisma.Decimal(s);
    throw new LedgerError('LEDGER_INEXACT_QUANTITY',
      `${label}: JS floating-point ${value} is not an exactly representable ledger quantity — pass Prisma.Decimal or an exact decimal string`);
  }
  if (typeof value === 'bigint') {
    if (value < 0n) throw new LedgerError('LEDGER_NEGATIVE_QUANTITY', `${label}: negative quantities are rejected`);
    return new Prisma.Decimal(value.toString());
  }
  throw new LedgerError('LEDGER_INEXACT_QUANTITY', `${label}: unsupported quantity type ${typeof value}`);
}

/** Deterministic identity hash over exact normalized economic content (line order canonicalized). */
function computePostingHash(entryType, normalizedLines, conversionRecord = null) {
  const canonical = normalizedLines
    .map(l => `${l.account}:${l.debit.toFixed(8)}:${l.credit.toFixed(8)}`)
    .sort()
    .join('|');
  // §P.5-A: conversion provenance is part of the economic identity; P4 hashes stay byte-identical.
  let identity = `${entryType}#${canonical}`;
  if (conversionRecord) {
    // Injective: arbitrary identity/quoteReference strings make ':' unsafe; fixed-key-order JSON is not.
    identity += `#conv:${JSON.stringify({
      identity: conversionRecord.identity,
      rate: conversionRecord.rate, // already the exact toFixed(8) string
      quoteReference: conversionRecord.quoteReference ?? null,
    })}`;
  }
  return crypto.createHash('sha256').update(identity).digest('hex');
}

/**
 * Classify an account code. Dynamic user-liability and escrow-locked codes are
 * derived; canonical codes come from the chart. Anything else fails closed.
 */
function classifyAccountCode(code) {
  if (typeof code !== 'string' || code.length === 0 || code.length > 80) {
    throw new LedgerError('LEDGER_UNKNOWN_ACCOUNT', `invalid account code: ${code}`);
  }
  const userMatch = USER_LIABILITY_RE.exec(code);
  if (userMatch) {
    return { kind: 'USER_LIABILITY', userId: Number(userMatch[1]), spec: { accountClass: 'LIABILITY', normalSide: 'CREDIT', asset: 'USDC', network: null } };
  }
  const escrowMatch = ESCROW_LOCKED_RE.exec(code);
  if (escrowMatch) {
    return { kind: 'ESCROW_LOCKED', key: escrowMatch[1], spec: { accountClass: 'LIABILITY', normalSide: 'CREDIT', asset: 'USDC', network: null } };
  }
  const userDisputeMatch = USER_DISPUTE_RE.exec(code);
  if (userDisputeMatch) {
    return { kind: 'USER_DISPUTE', userId: Number(userDisputeMatch[1]), spec: { accountClass: 'LIABILITY', normalSide: 'CREDIT', asset: 'USDC', network: null } };
  }
  const userUnallocatedMatch = USER_UNALLOCATED_RE.exec(code);
  if (userUnallocatedMatch) {
    return { kind: 'USER_UNALLOCATED', userId: Number(userUnallocatedMatch[1]), spec: { accountClass: 'LIABILITY', normalSide: 'CREDIT', asset: 'USDC', network: null } };
  }
  if (Object.prototype.hasOwnProperty.call(CANONICAL_ACCOUNTS, code)) {
    return { kind: 'CANONICAL', spec: CANONICAL_ACCOUNTS[code] };
  }
  throw new LedgerError('LEDGER_UNKNOWN_ACCOUNT',
    `account "${code}" is not part of the authoritative chart — refusing to post to an unmodelled account`);
}

/**
 * Susu per-member pool sub-account code. LedgerAccount.code (and the
 * classification gate in classifyAccountCode) cap account codes at 80 chars —
 * two full UUIDs overflow that, so each id is compacted to 12 hex/alnum
 * chars. Uniqueness across real cycles is 48 random bits per id pair;
 * every posting carries the FULL ids in relatedEntityId + metadata for
 * audit, so the compacted code is a routing key, not the record of truth.
 */
function susuEscrowCode(cycleId, memberId) {
  const compact = (id) => String(id).replace(/-/g, '').slice(0, 12);
  return `escrow:susu-${compact(cycleId)}-${compact(memberId)}:locked`;
}

/**
 * Ensure the LedgerAccount catalog row exists (idempotent upsert on the CALLER
 * transaction). Canonical + dynamic codes only; classification is never
 * rewritten.
 */
async function ensureAccount(tx, code, opts = {}) {
  const cls = classifyAccountCode(code);
  const spec = cls.spec;
  const userId = (cls.kind === 'USER_LIABILITY' || cls.kind === 'USER_DISPUTE' || cls.kind === 'USER_UNALLOCATED') ? cls.userId : (opts.userId ?? null);
  // Classification is authoritative — never rewritten. Prisma's upsert is not
  // atomic: concurrent FIRST USE collides on the code unique index; translated into a retryable error.
  let row;
  try {
    row = await tx.ledgerAccount.upsert({
      where: { code },
      update: {},
      create: {
        code,
        accountClass: spec.accountClass,
        normalSide: spec.normalSide,
        asset: spec.asset,
        network: spec.network,
        userId,
        status: 'ACTIVE',
      },
    });
  } catch (e) {
    const tgt = Array.isArray(e.meta?.target) ? e.meta.target.join(',') : String(e.meta?.target ?? '');
    if (e?.code === 'P2002' && tgt.includes('code')) {
      throw new LedgerError('LEDGER_ACCOUNT_CONTENTION',
        `account "${code}" is being created concurrently — the enclosing transaction rolled back; retry the posting`,
        { code });
    }
    throw e;
  }
  // §P.5-A: the persisted row must AGREE with the chart — a tampered or
  // misclassified row fails closed; the chart is never rewritten to match.
  const mismatch = [
    ['accountClass', row.accountClass, spec.accountClass],
    ['normalSide', row.normalSide, spec.normalSide],
    ['asset', row.asset, spec.asset],
    ['network', row.network ?? null, spec.network ?? null],
  ].filter(([, a, b]) => a !== b);
  if (mismatch.length) {
    throw new LedgerError('LEDGER_ACCOUNT_IDENTITY_CONFLICT',
      `account "${code}" persisted identity disagrees with the authoritative chart (${mismatch.join('; ')}) — refusing to post; the chart is never rewritten to match the row`,
      { code, persisted: { accountClass: row.accountClass, normalSide: row.normalSide, asset: row.asset, network: row.network }, canonical: spec });
  }
  return cls;
}

/**
 * THE authoritative posting primitive.
 *
 * @param {Object} tx  CALLER-OWNED Prisma transaction client. Required — a
 *   financial mutation must never commit without its accounting, and this
 *   service must never open an independent transaction underneath the caller.
 * @param {Object} params
 *   idempotencyKey {string}  durable unique economic identity (required)
 *   entryType {string}       JournalEntryType value (required)
 *   description {string}     (required)
 *   lines {Array<{account, debit?, credit?}>} >= 2, exact quantities
 *   conversion {identity, rate, quoteReference?} — REQUIRED for (and ONLY
 *     for) entryType ASSET_CONVERSION: the explicit durable cross-asset
 *     exchange identity. rate is the exact conversion rate provenance
 *     (asset-per-asset reference, e.g. GHS per USDC) — it is NEVER used to
 *     fabricate numeric equality between the asset legs; each leg balances
 *     exactly within its own asset.
 *   reference / userId / relatedEntity / relatedEntityId / metadata optional
 * @returns {{ transaction, entries, replayed }} replayed=true when the exact
 *   economic transaction already committed (postingHash proof) — the
 *   already-committed result is returned with NO second posting.
 * @throws LedgerError on any validation or consistency failure — which rolls
 *   back the ENTIRE enclosing financial transaction. Never swallowed here.
 */
async function post(tx, params) {
  if (!tx || typeof tx !== 'object' || typeof tx.ledgerTransaction?.create !== 'function') {
    throw new LedgerError('LEDGER_TX_REQUIRED',
      'ledgerService.post requires the CALLER-OWNED Prisma transaction client — authoritative financial mutations must never post outside their enclosing transaction');
  }
  const {
    idempotencyKey, entryType, description, lines, conversion,
    reference, userId, relatedEntity, relatedEntityId, metadata,
  } = params || {};

  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 140) {
    throw new LedgerError('LEDGER_IDEMPOTENCY_KEY_REQUIRED', 'a durable idempotencyKey (1-140 chars) is required');
  }
  if (!ENTRY_TYPES.has(entryType)) {
    throw new LedgerError('LEDGER_INVALID_ENTRY_TYPE', `entryType "${entryType}" is not a JournalEntryType value`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new LedgerError('LEDGER_DESCRIPTION_REQUIRED', 'description is required');
  }
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new LedgerError('LEDGER_MIN_LINES', 'at least 2 posting lines are required for a balanced double entry');
  }

  // ── Exact normalization + per-line validation ────────────────────────────
  const normalized = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || {};
    const debit = line.debit === undefined || line.debit === null ? new Prisma.Decimal(0) : toExactDecimal(line.debit, `line[${i}].debit`);
    const credit = line.credit === undefined || line.credit === null ? new Prisma.Decimal(0) : toExactDecimal(line.credit, `line[${i}].credit`);
    if (debit.isZero() && credit.isZero()) {
      throw new LedgerError('LEDGER_ZERO_LINE', `line[${i}] (${line.account}) is zero-value — zero-value lines are rejected`);
    }
    if (!debit.isZero() && !credit.isZero()) {
      throw new LedgerError('LEDGER_BOTH_SIDES', `line[${i}] (${line.account}) has BOTH debit and credit — each line is exactly one side`);
    }
    normalized.push({ account: line.account, debit, credit });
  }

  // ── §P.5-A conversion context validation (pure — fails before any DB touch) ──
  if (entryType === 'ASSET_CONVERSION' && !conversion) {
    throw new LedgerError('LEDGER_CONVERSION_CONTEXT_REQUIRED',
      'entryType ASSET_CONVERSION requires an explicit conversion context { identity, rate } — cross-asset exchange is never implicit');
  }
  if (conversion && entryType !== 'ASSET_CONVERSION') {
    throw new LedgerError('LEDGER_CONVERSION_ENTRY_TYPE_REQUIRED',
      `a conversion context is only valid with entryType ASSET_CONVERSION (got "${entryType}")`);
  }
  let conversionRecord = null;
  if (conversion) {
    if (typeof conversion !== 'object') {
      throw new LedgerError('LEDGER_CONVERSION_INVALID', 'conversion context must be an object { identity, rate, quoteReference? }');
    }
    if (typeof conversion.identity !== 'string' || conversion.identity.length === 0 || conversion.identity.length > 140) {
      throw new LedgerError('LEDGER_CONVERSION_INVALID', 'conversion.identity (1-140 chars) is required — the durable exchange reference');
    }
    let rate;
    try {
      rate = toExactDecimal(conversion.rate, 'conversion.rate');
    } catch (e) {
      throw new LedgerError('LEDGER_CONVERSION_INVALID',
        `conversion.rate must be an exact positive decimal (<= 8 decimals, no exponent) — ${e.message}`);
    }
    if (rate.isZero()) {
      throw new LedgerError('LEDGER_CONVERSION_INVALID', 'conversion.rate must be a positive exact decimal — a zero rate is not an exchange relationship');
    }
    if (typeof conversion.quoteReference !== 'undefined'
        && (typeof conversion.quoteReference !== 'string' || conversion.quoteReference.length > 140)) {
      throw new LedgerError('LEDGER_CONVERSION_INVALID', 'conversion.quoteReference must be a string (<= 140 chars)');
    }
    conversionRecord = {
      identity: conversion.identity,
      rate: rate.toFixed(8),
      quoteReference: conversion.quoteReference ?? null,
    };
  }

  // ── §P.5-A asset-identity balancing — identity precedes arithmetic: a normal
  // posting lives in ONE asset; an ASSET_CONVERSION balances every leg on its own.
  const zeroQ = new Prisma.Decimal(0);
  const perAsset = new Map();
  for (const l of normalized) {
    const a = classifyAccountCode(l.account).spec.asset;
    let b = perAsset.get(a);
    if (!b) { b = { debit: zeroQ, credit: zeroQ }; perAsset.set(a, b); }
    b.debit = b.debit.plus(l.debit);
    b.credit = b.credit.plus(l.credit);
  }
  const assets = [...perAsset.keys()];
  const assetDetail = {};
  for (const [a, b] of perAsset) assetDetail[a] = { debit: b.debit.toFixed(8), credit: b.credit.toFixed(8) };

  if (!conversionRecord && assets.length > 1) {
    throw new LedgerError('LEDGER_CROSS_ASSET_BALANCE',
      `posting mixes incompatible asset identities [${assets.join(', ')}] — numeric debit/credit equality is NOT an accounting equality across assets; use an explicit ASSET_CONVERSION posting`,
      { assets, perAsset: assetDetail });
  }
  if (conversionRecord) {
    if (assets.length < 2) {
      throw new LedgerError('LEDGER_CONVERSION_SINGLE_ASSET',
        `an ASSET_CONVERSION posting must carry legs in >= 2 distinct assets (got only [${assets.join(', ')}])`);
    }
    const unbalanced = assets.filter(a => !perAsset.get(a).debit.eq(perAsset.get(a).credit));
    if (unbalanced.length) {
      throw new LedgerError('LEDGER_CONVERSION_LEG_UNBALANCED',
        `ASSET_CONVERSION legs for [${unbalanced.join(', ')}] do not balance within their own asset — each asset leg must balance exactly (GHS and USDC are never equated numerically)`,
        { perAsset: assetDetail });
    }
    conversionRecord.assets = assets.sort();
  }

  // ── Exact balance: debits == credits (Decimal arithmetic, no epsilon) ─────
  const zero = new Prisma.Decimal(0);
  let totalDebit = zero, totalCredit = zero;
  for (const l of normalized) { totalDebit = totalDebit.plus(l.debit); totalCredit = totalCredit.plus(l.credit); }
  if (totalDebit.isZero()) {
    throw new LedgerError('LEDGER_ZERO_POSTING', 'zero-value posting rejected');
  }
  if (!totalDebit.eq(totalCredit)) {
    throw new LedgerError('LEDGER_UNBALANCED',
      `unbalanced posting: debits ${totalDebit.toFixed(8)} != credits ${totalCredit.toFixed(8)}`,
      { totalDebit: totalDebit.toFixed(8), totalCredit: totalCredit.toFixed(8) });
  }

  // ── Fail-closed account catalog ──────────────────────────────────────────
  // ensureAccount also verifies the persisted row against the chart (LEDGER_ACCOUNT_IDENTITY_CONFLICT).
  const uniqueAccounts = [...new Set(normalized.map(l => l.account))];
  for (const code of uniqueAccounts) {
    await ensureAccount(tx, code, { userId });
  }

  // ── Durable conversion identity: DB UNIQUE enforces; pre-read for a clear error. ──
  if (conversionRecord) {
    const priorIdentity = await tx.ledgerTransaction.findFirst({
      where: { conversionIdentity: conversionRecord.identity },
      select: { idempotencyKey: true },
    });
    if (priorIdentity && priorIdentity.idempotencyKey !== idempotencyKey) {
      throw new LedgerError('LEDGER_CONVERSION_IDENTITY_CONFLICT',
        `conversion identity "${conversionRecord.identity}" was already committed by posting ${priorIdentity.idempotencyKey} — a conversion identity is exactly-once and never reused`);
    }
  }

  const postingHash = computePostingHash(entryType, normalized, conversionRecord);

  // ── Exactly-once economic identity ────────────────────────────────────────
  const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.postingHash !== postingHash) {
      throw new LedgerError('LEDGER_IDEMPOTENCY_CONFLICT',
        `idempotencyKey "${idempotencyKey}" already committed a DIFFERENT posting (hash ${existing.postingHash} != ${postingHash}) — refusing to overwrite economic history`,
        { existingHash: existing.postingHash, attemptedHash: postingHash });
    }
    const entries = await tx.journalEntry.findMany({
      where: { ledgerTransactionId: existing.id },
      orderBy: { lineNumber: 'asc' },
    });
    logger.info({ idempotencyKey, ledgerTransactionId: existing.id }, '[ledger] exact replay — returning committed posting');
    return { transaction: existing, entries, replayed: true };
  }

  // ── Create the posting group + lines on the CALLER transaction ────────────
  const transaction = await tx.ledgerTransaction.create({
    data: {
      idempotencyKey,
      entryType,
      description,
      reference: reference ?? null,
      userId: userId ?? null,
      relatedEntity: relatedEntity ?? null,
      relatedEntityId: relatedEntityId != null ? String(relatedEntityId) : null,
      postingHash,
      conversionIdentity: conversionRecord ? conversionRecord.identity : null,
      // metadata.conversion keeps the full audit record; conversionIdentity is the DB-enforced key.
      metadata: conversionRecord
        ? { ...(metadata ?? {}), conversion: conversionRecord }
        : (metadata ?? null),
    },
  }).catch((e) => {
    const tgt = Array.isArray(e.meta?.target) ? e.meta.target.join(',') : String(e.meta?.target ?? '');
    if (e?.code === 'P2002' && tgt.includes('conversionIdentity')) {
      // Concurrent conversion on the SAME identity committed first — fail closed.
      throw new LedgerError('LEDGER_CONVERSION_IDENTITY_CONFLICT',
        `conversion identity "${conversionRecord.identity}" was committed concurrently — a conversion identity is exactly-once and never reused`);
    }
    throw e;
  });

  const entries = [];
  for (let i = 0; i < normalized.length; i++) {
    const l = normalized[i];
    entries.push(await tx.journalEntry.create({
      data: {
        transactionId: idempotencyKey, // legacy grouping string for external readers; authority is ledgerTransactionId
        entryType,
        account: l.account,
        debit: l.debit,
        credit: l.credit,
        description,
        reference: reference ?? null,
        metadata: metadata ?? null,
        userId: userId ?? null,
        relatedEntity: relatedEntity ?? null,
        relatedEntityId: relatedEntityId != null ? String(relatedEntityId) : null,
        ledgerTransactionId: transaction.id,
        lineNumber: i + 1,
      },
    }));
  }

  logger.info({ idempotencyKey, ledgerTransactionId: transaction.id, entryType, totalDebit: totalDebit.toFixed(8), lines: entries.length }, '[ledger] authoritative posting created');
  return { transaction, entries, replayed: false };
}

/**
 * Exact balance of an authoritative account (positive = normal side).
 * Only P4-linked lines count — legacy shadow rows (ledgerTransactionId null)
 * are excluded so the authoritative balance can never inherit pre-P4 float
 * postings.
 */
async function accountBalance(db, code) {
  const agg = await db.journalEntry.aggregate({
    where: { account: code, ledgerTransactionId: { not: null } },
    _sum: { debit: true, credit: true },
  });
  const debit = agg._sum.debit || new Prisma.Decimal(0);
  const credit = agg._sum.credit || new Prisma.Decimal(0);
  const acct = await db.ledgerAccount.findUnique({ where: { code } });
  const normalSide = acct?.normalSide || classifyAccountCode(code).spec.normalSide;
  const net = debit.minus(credit); // debit-positive net
  return {
    code,
    debit,
    credit,
    normalSide,
    balance: normalSide === 'DEBIT' ? net : net.neg(), // positive = normal-side balance
    netDebit: net,
  };
}

/**
 * Authoritative customer AVAILABLE liability (credits - debits on
 * user:{id}:liability). This is the accounting counterpart of
 * User.availableBalance on migrated paths.
 */
async function userLiabilityBalance(db, userId) {
  const b = await accountBalance(db, `user:${userId}:liability`);
  return b.balance;
}

/**
 * Exact residual between a stored total and the sum of the share values the
 * projections actually credited (both as exact decimals). Used by migrated
 * writers whose float-rounded shares may not re-sum to the stored principal
 * bit-exactly: the residual is absorbed by the platform revenue line so the
 * posting balances EXACTLY without minting or destroying value, while the
 * customer liability lines stay byte-identical to the projections.
 * Positive = distribution was short (revenue gains the dust);
 * negative = distribution overshot (revenue absorbs the shortfall).
 */
function exactResidual(total, parts) {
  const t = toExactDecimal(total, 'residual.total');
  let sum = new Prisma.Decimal(0);
  for (let i = 0; i < parts.length; i++) {
    sum = sum.plus(toExactDecimal(parts[i], `residual.part[${i}]`));
  }
  return t.minus(sum);
}

module.exports = {
  LedgerError,
  post,
  toExactDecimal,
  computePostingHash,
  ensureAccount,
  accountBalance,
  userLiabilityBalance,
  exactResidual,
  CANONICAL_ACCOUNTS,
  classifyAccountCode,
  susuEscrowCode,
};
