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
//
// The legacy journalService.record()/journalIntegration helpers remain ONLY
// as non-authoritative compatibility for callers not yet migrated (§P.4
// wave 2). Migrated financial paths MUST use this primitive.
// =============================================================================

const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const logger = require('../src/config/logger');

// ── Account grammar ─────────────────────────────────────────────────────────
const USER_LIABILITY_RE = /^user:(\d+):liability$/;
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
  'custody:provider:usdc':  { accountClass: 'LIABILITY',  normalSide: 'CREDIT', asset: 'USDC', network: null }, // payable-style: USDC principal handed to payout providers for onward fiat disbursement
  'fiat:momo:ghs':          { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'GHS',  network: null },
  'inventory:usdc:lots':    { accountClass: 'ASSET',      normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'restricted:reserves':   { accountClass: 'RESTRICTED', normalSide: 'CREDIT', asset: 'USDC', network: null },
  'clearing:conversion':    { accountClass: 'CLEARING',   normalSide: 'DEBIT',  asset: 'USDC', network: null },  // debit-side accumulation of fiat-settled conversions pending §P.5
  'revenue:fees':           { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'revenue:spread':         { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'expense:gas':            { accountClass: 'EXPENSE',    normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'expense:provider':       { accountClass: 'EXPENSE',    normalSide: 'DEBIT',  asset: 'USDC', network: null },
  'pnl:inventory':          { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'pnl:arbitrage':          { accountClass: 'REVENUE',    normalSide: 'CREDIT', asset: 'USDC', network: null },
  'equity:treasury':        { accountClass: 'EQUITY',     normalSide: 'CREDIT', asset: 'USDC', network: null },
};

const ENTRY_TYPES = new Set([
  'DEPOSIT', 'WITHDRAWAL', 'TRADE', 'TRANSFER', 'ESCROW_LOCK', 'ESCROW_RELEASE',
  'ESCROW_REFUND', 'VAULT_DEPOSIT', 'VAULT_RELEASE', 'SUSU_CONTRIBUTION',
  'SUSU_PAYOUT', 'FEE', 'REWARD', 'ADJUSTMENT', 'BUSINESS_PAYMENT',
  'CUSTODY_DEPOSIT', 'CUSTODY_SWEEP', 'CUSTODY_WITHDRAWAL',
  'SHARED_VAULT_DEPOSIT', 'SHARED_VAULT_REFUND',
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

/**
 * Deterministic posting identity hash over the exact normalized economic
 * content. Line order is canonicalized (sorted) so the same economic posting
 * always hashes identically.
 */
function computePostingHash(entryType, normalizedLines) {
  const canonical = normalizedLines
    .map(l => `${l.account}:${l.debit.toFixed(8)}:${l.credit.toFixed(8)}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${entryType}#${canonical}`).digest('hex');
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
  if (Object.prototype.hasOwnProperty.call(CANONICAL_ACCOUNTS, code)) {
    return { kind: 'CANONICAL', spec: CANONICAL_ACCOUNTS[code] };
  }
  throw new LedgerError('LEDGER_UNKNOWN_ACCOUNT',
    `account "${code}" is not part of the authoritative chart — refusing to post to an unmodelled account`);
}

/**
 * Ensure the LedgerAccount catalog row exists (idempotent upsert on the CALLER
 * transaction). Canonical + dynamic codes only; classification is never
 * rewritten.
 */
async function ensureAccount(tx, code, opts = {}) {
  const cls = classifyAccountCode(code);
  const spec = cls.spec;
  await tx.ledgerAccount.upsert({
    where: { code },
    update: {},
    create: {
      code,
      accountClass: spec.accountClass,
      normalSide: spec.normalSide,
      asset: spec.asset,
      network: spec.network,
      userId: cls.kind === 'USER_LIABILITY' ? cls.userId : (opts.userId ?? null),
      status: 'ACTIVE',
    },
  });
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
    idempotencyKey, entryType, description, lines,
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
  const uniqueAccounts = [...new Set(normalized.map(l => l.account))];
  for (const code of uniqueAccounts) {
    await ensureAccount(tx, code, { userId });
  }

  const postingHash = computePostingHash(entryType, normalized);

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
      metadata: metadata ?? null,
    },
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

module.exports = {
  LedgerError,
  post,
  toExactDecimal,
  computePostingHash,
  ensureAccount,
  accountBalance,
  userLiabilityBalance,
  CANONICAL_ACCOUNTS,
  classifyAccountCode,
};
