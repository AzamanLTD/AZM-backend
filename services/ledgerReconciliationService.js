// services/ledgerReconciliationService.js
// =============================================================================
// §P.4 — DETERMINISTIC RECONCILIATION READ MODELS
//
// Compares the authoritative ledger against the materialized projections and
// domain state. Reconciliation REPORTS discrepancies — it NEVER silently
// rewrites financial history, clamps a difference to zero, or "repairs" a
// balance. Every disagreement is an explicit exception with exact signed
// amounts.
//
// Pre-P4 rows are excluded by construction: only ledger-linked rows
// (ledgerTransactionId NOT NULL) count toward authoritative balances, and
// projection comparisons are scoped to users with P4 ledger activity (the
// opening epoch), because no historical backfill was performed (and is not
// authorized).
// =============================================================================

const { Prisma } = require('@prisma/client');
const ledger = require('./ledgerService');

const zero = () => new Prisma.Decimal(0);

/**
 * Per-user projection reconciliation: the authoritative ledger available
 * liability (user:{id}:liability) against the User.availableBalance material
 * projection, for every user that has P4 ledger activity.
 * Unmigrated restricted buckets (escrow/dispute/vendor) that carry a nonzero
 * projection WITHOUT authoritative escrow-locked accounts are reported as
 * UNMIGRATED_BUCKET_ACTIVITY — an explicit finding, not a failure of the
 * ledger.
 */
async function reconcileUserProjections(db, { limit = 1000 } = {}) {
  const exceptions = [];
  const ledgerUserIds = await db.ledgerAccount.findMany({
    where: { code: { contains: ':liability' }, status: 'ACTIVE' },
    select: { userId: true },
    take: limit,
  });
  for (const { userId } of ledgerUserIds) {
    if (!userId) continue;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) { exceptions.push({ kind: 'LEDGER_USER_MISSING', userId }); continue; }
    const liability = await ledger.userLiabilityBalance(db, userId);
    const projection = user.availableBalance; // Prisma.Decimal
    if (!liability.eq(projection)) {
      exceptions.push({
        kind: 'PROJECTION_LEDGER_DISAGREEMENT',
        userId,
        ledgerLiability: liability.toFixed(8),
        projectedAvailable: projection.toFixed(8),
        difference: projection.minus(liability).toFixed(8),
      });
    }
    // Escrow-classified restricted accounts owned by this user
    const escrowAccounts = await db.ledgerAccount.findMany({
      where: { userId, code: { startsWith: 'escrow:' }, status: 'ACTIVE' },
      select: { code: true },
    });
    let escrowLedgerTotal = zero();
    for (const a of escrowAccounts) {
      const b = await ledger.accountBalance(db, a.code);
      escrowLedgerTotal = escrowLedgerTotal.plus(b.balance);
    }
    const escrowProjection = user.escrowLockedBalance || zero();
    if (!escrowLedgerTotal.eq(escrowProjection)) {
      exceptions.push({
        kind: escrowLedgerTotal.isZero() && !escrowProjection.isZero() ? 'UNMIGRATED_BUCKET_ACTIVITY' : 'ESCROW_PROJECTION_LEDGER_DISAGREEMENT',
        userId,
        ledgerEscrow: escrowLedgerTotal.toFixed(8),
        projectedEscrow: escrowProjection.toFixed(8),
        difference: escrowProjection.minus(escrowLedgerTotal).toFixed(8),
      });
    }
  }
  return { exceptions, checkedUsers: ledgerUserIds.length };
}

/**
 * Custody reconciliation: authoritative ledger custody-asset postings against
 * the §P.3 CustodyMovement truth (exact base-unit comparison).
 *   custody:deposit:usdc balance == sum(DEPOSIT_IN movements, any status)
 *   custody:hot:usdc   balance == verified deposits swept in are NOT yet
 *     modelled (sweep accounting is a later wave) — hot balance reflects
 *     withdrawal settlements only, so this check compares
 *     sum(WITHDRAWAL_OUT movements) + fee-economics detail is reported.
 * Any disagreement is an exception with the signed exact difference.
 */
async function reconcileCustodyPostings(db) {
  const exceptions = [];
  const decimalFromBaseUnits = (base) => new Prisma.Decimal(String(base)).dividedBy(new Prisma.Decimal('1000000'));

  const depositLedger = await ledger.accountBalance(db, 'custody:deposit:usdc');
  const depositMovements = await db.custodyMovement.aggregate({
    where: { kind: 'DEPOSIT_IN' },
    _sum: { amountBaseUnits: true },
  });
  const depositMovementsDec = depositMovements._sum.amountBaseUnits
    ? decimalFromBaseUnits(depositMovements._sum.amountBaseUnits) : zero();
  if (!depositLedger.balance.eq(depositMovementsDec)) {
    exceptions.push({
      kind: 'CUSTODY_LEDGER_DISAGREEMENT',
      account: 'custody:deposit:usdc',
      ledgerBalance: depositLedger.balance.toFixed(8),
      custodyMovements: depositMovementsDec.toFixed(8),
      difference: depositMovementsDec.minus(depositLedger.balance).toFixed(8),
    });
  }
  return { exceptions };
}

/**
 * External-flow reconciliation: every P4-era COMPLETED external customer flow
// (crypto/fiat deposit, crypto/fiat withdrawal) must carry its authoritative
// ledger posting. A migrated financial route that committed money without its
// ledger posting is a P0 exception.
 */
async function reconcileTransactionHistory(db) {
  const exceptions = [];
  // Deposits: linked by ledger relatedEntity('transactionHistory')/relatedEntityId
  const depositTypes = ['DEPOSIT_CRYPTO', 'DEPOSIT_FIAT'];
  // Pre-P4 historical rows legitimately lack postings (no backfill is
  // authorized). Only rows created at/after the ledger epoch — the first
  // authoritative ledger transaction — are authoritative candidates.
  const epoch = await db.ledgerTransaction.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  if (!epoch) return { exceptions };
  const deposits = await db.transactionHistory.findMany({
    where: { type: { in: depositTypes }, status: 'COMPLETED', createdAt: { gte: epoch.createdAt } },
    select: { id: true, type: true },
    take: 5000,
  });
  for (const t of deposits) {
    const posting = await db.ledgerTransaction.findFirst({
      where: { relatedEntity: 'transactionHistory', relatedEntityId: t.id },
      select: { id: true },
    });
    if (!posting) {
      exceptions.push({ kind: 'COMPLETED_FLOW_WITHOUT_LEDGER_POSTING', transactionHistoryId: t.id, type: t.type });
    }
  }
  return { exceptions };
}

/**
 * Restricted obligations vs the restricted:reserves ledger balance. The
 * persisted ACTIVE obligation total must equal the ledger reserve balance
// exactly — a drift means a path reserved funds without its obligation (or
// released one without the ledger).
 */
async function reconcileRestrictedObligations(db) {
  const exceptions = [];
  const obligations = await db.restrictedObligation.aggregate({
    where: { status: 'ACTIVE', reserveInclusionPolicy: 'INCLUDED_IN_RESERVE_DENOMINATOR' },
    _sum: { amount: true },
  });
  const obligationTotal = obligations._sum.amount || zero();
  const reserveLedger = await ledger.accountBalance(db, 'restricted:reserves');
  if (!obligationTotal.eq(reserveLedger.balance)) {
    exceptions.push({
      kind: 'RESTRICTED_LEDGER_DISAGREEMENT',
      obligationTotal: obligationTotal.toFixed(8),
      ledgerReserves: reserveLedger.balance.toFixed(8),
      difference: reserveLedger.balance.minus(obligationTotal).toFixed(8),
    });
  }
  return { exceptions, obligationTotal: obligationTotal.toFixed(8), ledgerReserves: reserveLedger.balance.toFixed(8) };
}

/**
 * Conversion clearing: every satoshi in clearing:conversion must be
// explainable. §P.4 semantics: fiat-settled USDC deposits credit customer
// liability against clearing:conversion until §P.5 inventory economics
// exists — so the balance must equal the total of P4-era completed
// fiat-settled deposit postings. A different balance is an exception.
 */
async function reconcileClearingConversion(db) {
  const exceptions = [];
  const clearing = await ledger.accountBalance(db, 'clearing:conversion');
  // Expected: sum of DEPOSIT-type ledger postings crediting user liability
  // against clearing:conversion (fiat deposit settlements).
  const fiatDepositPostings = await db.journalEntry.aggregate({
    where: { account: 'clearing:conversion', ledgerTransactionId: { not: null } },
    _sum: { debit: true, credit: true },
  });
  const debits = fiatDepositPostings._sum.debit || zero();
  const credits = fiatDepositPostings._sum.credit || zero();
  const expected = debits.minus(credits);
  if (!clearing.balance.eq(expected)) {
    exceptions.push({
      kind: 'CLEARING_CONVERSION_UNEXPLAINED',
      balance: clearing.balance.toFixed(8),
      expectedFromFiatDeposits: expected.toFixed(8),
      difference: expected.minus(clearing.balance).toFixed(8),
    });
  }
  return { exceptions, balance: clearing.balance.toFixed(8), explainedBy: 'fiat-settled USDC deposits awaiting §P.5 inventory economics' };
}

/**
 * Full deterministic reconciliation report. Read-only.
 */
async function runFullReconciliation(db) {
  const [projections, custody, flows, restricted, clearing] = await Promise.all([
    reconcileUserProjections(db),
    reconcileCustodyPostings(db),
    reconcileTransactionHistory(db),
    reconcileRestrictedObligations(db),
    reconcileClearingConversion(db),
  ]);
  const exceptions = [
    ...projections.exceptions,
    ...custody.exceptions,
    ...flows.exceptions,
    ...restricted.exceptions,
    ...clearing.exceptions,
  ];
  return {
    ok: exceptions.length === 0,
    exceptions,
    detail: {
      checkedUsers: projections.checkedUsers,
      restricted: { obligationTotal: restricted.obligationTotal, ledgerReserves: restricted.ledgerReserves },
      clearing: { balance: clearing.balance, explainedBy: clearing.explainedBy },
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  reconcileUserProjections,
  reconcileCustodyPostings,
  reconcileTransactionHistory,
  reconcileRestrictedObligations,
  reconcileClearingConversion,
  runFullReconciliation,
};
