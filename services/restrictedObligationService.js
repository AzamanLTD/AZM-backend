// services/restrictedObligationService.js
// =============================================================================
// §P.4 — AUTHORITATIVE PERSISTED RESTRICTED OBLIGATIONS
//
// Proof of Reserves needs the denominator:
//   eligible real USDC assets >= customer USDC liabilities + restricted
//   obligations
// §P.3 left restricted obligations explicitly unmodelled (PoR could never
// claim fully backed). This service establishes the authoritative persisted
// representation: each obligation LINKS to the existing domain state that
// owns it (custody execution, escrow, dispute, ...) — it never copies a
// balance that could drift, and it never invents regulatory amounts the
// repository does not define.
//
// Every mutated wave-1 financial path that reserves customer funds for an
// external operation creates its RestrictedObligation inside the SAME caller
// transaction as the ledger posting; release/cancel happens inside the
// settlement/reversal transaction. Exactly-once by unique reference.
// =============================================================================

const { Prisma } = require('@prisma/client');

// Source families the reserve denominator requires. A family is AUTHORITATIVE
// once its owning domain creates/releases obligations through this service on
// every path. Until ALL families are authoritative, the denominator is
// INCOMPLETE and PoR must remain fail-closed (cannot claim fully backed) —
// unknown restricted obligations are NEVER treated as zero.
// Representation semantics (post §P.4 wave-2, every financial writer migrated):
//   'RESTRICTED_OBLIGATION_ROW' — funds reserved for a PENDING EXTERNAL
//     operation (provider payout / on-chain withdrawal). The reservation
//     atomically moves the amount OUT of the customer's materialized
//     liability projection (available) into restricted:reserves, so the
//     PoR customer-liability authority (§P.4 wave-3: the materialized
//     projections, NEVER the historical flow totals) already EXCLUDES it —
//     the denominator adds it back here EXACTLY ONCE as the separately
//     modeled restricted component. No double counting in either
//     direction: the flow-based X (custodyAccounting.classifyUsdcLiabilityFlows)
//     legitimately still contains the amount until the external debit
//     completes, which is exactly why flows are reconciliation evidence
//     only and are compared against customer + restricted.
//   'LEDGER_RECLASSIFICATION'  — restricted funds that are an INTERNAL
//     reclassification WITHIN customer liability (available → escrow /
//     dispute / vendor pool). These remain fully counted inside X (the flow
//     classification is bucket-agnostic: a deposited, never-withdrawn USDC
//     is owed to the customer regardless of which projection bucket holds
//     it). They MUST NOT be added to the restricted-obligation denominator
//     — that would double count them. Authoritative means: EVERY financial
//     writer of the bucket posts its ledger reclassification in the same
//     transaction (guaranteed by the §P.4 architectural tests), and the
//     authoritative totals below report the exact ledger balances for
//     observability.
const SOURCE_FAMILIES = {
  PENDING_FIAT_WITHDRAWAL:   { authoritative: true, representation: 'RESTRICTED_OBLIGATION_ROW', description: 'Customer funds reserved for a PENDING MTN MoMo payout (settled/reversed only on provider outcome).' },
  PENDING_CRYPTO_WITHDRAWAL: { authoritative: true, representation: 'RESTRICTED_OBLIGATION_ROW', description: 'Customer funds reserved for a PENDING on-chain withdrawal (CustodyExecution).' },
  ESCROW_LOCK:               { authoritative: true, representation: 'LEDGER_RECLASSIFICATION', ledgerAccountPattern: /^escrow:[A-Za-z0-9][A-Za-z0-9_.-]*:locked$/, description: 'P2P/SmartEscrow/booking/vault/savings/susu restricted funds — authoritative via the escrow:{key}:locked ledger reclassification, reconciled against User.escrowLockedBalance.' },
  DISPUTE_ESCROW:             { authoritative: true, representation: 'LEDGER_RECLASSIFICATION', ledgerAccountPattern: /^user:\d+:dispute$/, description: 'Dispute-locked customer funds — authoritative via the user:{id}:dispute ledger reclassification, reconciled against User.disputeEscrowBalance.' },
  VENDOR_UNALLOCATED:         { authoritative: true, representation: 'LEDGER_RECLASSIFICATION', ledgerAccountPattern: /^user:\d+:unallocated$/, description: 'Vendor pool allocations — authoritative via the user:{id}:unallocated ledger reclassification, reconciled against User.vendorUnallocatedBalance.' },
};

// Exact sum of normal-side balances of the authoritative ledger accounts that
// match a reclassification family's account pattern (positive balances only —
// an account on the wrong side reports negative and is surfaced, never
// silently floored to zero).
async function _ledgerReclassificationTotal(db, pattern) {
  const zero = new Prisma.Decimal(0);
  const groups = await db.journalEntry.groupBy({
    by: ['account'],
    where: { ledgerTransactionId: { not: null } },
    _sum: { debit: true, credit: true },
  });
  let total = zero;
  for (const g of groups) {
    if (!pattern.test(g.account)) continue;
    const debit = g._sum.debit || zero;
    const credit = g._sum.credit || zero;
    total = total.plus(credit.minus(debit)); // LIABILITY/CREDIT normal side
  }
  return total;
}

function assertKnownSource(sourceType) {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_FAMILIES, sourceType)) {
    throw new Error(`restrictedObligations: unknown source family "${sourceType}" — fail closed`);
  }
}

/**
 * Create (idempotently) the restricted obligation for a pending external
 * operation, INSIDE the caller's transaction, linked to the ledger posting
 * that reserved the funds.
 */
async function createForPendingWithdrawal(tx, {
  sourceType, reference, userId, amount, asset = 'USDC', network = null,
  sourceEntity, sourceEntityId, ledgerTransactionId, domainStateRef, metadata,
}) {
  assertKnownSource(sourceType);
  const amountExact = require('./ledgerService').toExactDecimal(amount, 'restricted obligation amount');
  if (amountExact.isZero()) throw new Error('restrictedObligations: zero-value obligation rejected');

  const existing = await tx.restrictedObligation.findUnique({ where: { reference } });
  if (existing) {
    if (existing.status !== 'ACTIVE' || !existing.amount.eq(amountExact)) {
      throw new Error(`restrictedObligations: reference "${reference}" already exists with conflicting state — refusing to overwrite`);
    }
    return { obligation: existing, isNew: false };
  }
  const obligation = await tx.restrictedObligation.create({
    data: {
      reference,
      sourceType,
      sourceEntity: sourceEntity ?? null,
      sourceEntityId: sourceEntityId != null ? String(sourceEntityId) : null,
      userId: userId ?? null,
      asset,
      network,
      amount: amountExact,
      status: 'ACTIVE',
      reserveInclusionPolicy: 'INCLUDED_IN_RESERVE_DENOMINATOR',
      ledgerTransactionId: ledgerTransactionId ?? null,
      domainStateRef: domainStateRef ?? null,
      metadata: metadata ?? null,
    },
  });
  return { obligation, isNew: true };
}

/**
 * Release on verified provider settlement — conditional single-winner claim
 * (ACTIVE -> RELEASED). Idempotent: already-RELEASED is a no-op success.
 */
async function releaseOnSettlement(tx, { reference, releaseLedgerTransactionId, settledAmount }) {
  const claim = await tx.restrictedObligation.updateMany({
    where: { reference, status: 'ACTIVE' },
    data: { status: 'RELEASED', releaseLedgerTransactionId: releaseLedgerTransactionId ?? null, releasedAt: new Date() },
  });
  if (claim.count === 1) {
    if (settledAmount != null) {
      const row = await tx.restrictedObligation.findUnique({ where: { reference } });
      const settled = require('./ledgerService').toExactDecimal(settledAmount, 'settled amount');
      if (!row.amount.eq(settled)) {
        throw new Error(`restrictedObligations: settled amount ${settled.toFixed(8)} != reserved ${row.amount.toFixed(8)} on ${reference}`);
      }
    }
    return { released: true };
  }
  const existing = await tx.restrictedObligation.findUnique({ where: { reference } });
  if (!existing) throw new Error(`restrictedObligations: release requested for unknown reference "${reference}"`);
  if (existing.status !== 'RELEASED') {
    throw new Error(`restrictedObligations: cannot release ${reference} in status ${existing.status}`);
  }
  return { released: false, alreadyReleased: true };
}

/**
 * Cancel on definitive reversal/refund — conditional single-winner claim
 * (ACTIVE -> CANCELLED). Idempotent for already-CANCELLED.
 */
async function cancelOnReversal(tx, { reference, releaseLedgerTransactionId }) {
  const claim = await tx.restrictedObligation.updateMany({
    where: { reference, status: 'ACTIVE' },
    data: { status: 'CANCELLED', releaseLedgerTransactionId: releaseLedgerTransactionId ?? null, releasedAt: new Date() },
  });
  if (claim.count === 1) return { cancelled: true };
  const existing = await tx.restrictedObligation.findUnique({ where: { reference } });
  if (!existing) throw new Error(`restrictedObligations: cancel requested for unknown reference "${reference}"`);
  if (existing.status !== 'CANCELLED') {
    throw new Error(`restrictedObligations: cannot cancel ${reference} in status ${existing.status}`);
  }
  return { cancelled: false, alreadyCancelled: true };
}

/**
 * Authoritative restricted-obligation denominator for PoR.
 * Returns { total, complete, families }.
 *   total    — exact sum of ACTIVE, INCLUDED_IN_RESERVE_DENOMINATOR obligations
 *   complete — true ONLY when every required source family is authoritative.
 *              While any family is unmodelled the denominator is incomplete
 *              and PoR must keep reporting its inability to prove full
 *              backing (never a zero for the unknown part).
 */
async function authoritativeTotals(db, { asset = 'USDC' } = {}) {
  const zero = new Prisma.Decimal(0);
  const active = await db.restrictedObligation.aggregate({
    where: { status: 'ACTIVE', asset, reserveInclusionPolicy: 'INCLUDED_IN_RESERVE_DENOMINATOR' },
    _sum: { amount: true },
  });
  const total = active._sum.amount || zero;

  const byFamilyRows = await db.restrictedObligation.groupBy({
    by: ['sourceType'],
    where: { status: 'ACTIVE', asset },
    _sum: { amount: true },
  });
  const byFamily = {};
  for (const r of byFamilyRows) byFamily[r.sourceType] = r._sum.amount || zero;

  const families = {};
  let complete = true;
  for (const [family, def] of Object.entries(SOURCE_FAMILIES)) {
    if (def.representation === 'LEDGER_RECLASSIFICATION') {
      // Authoritative amount comes from the LEDGER reclassification balances
      // (observability only — NOT added to `total`, because the flow-based
      // customer liability X already counts these funds once).
      const ledgerTotal = def.authoritative
        ? await _ledgerReclassificationTotal(db, def.ledgerAccountPattern)
        : null;
      families[family] = {
        authoritative: def.authoritative,
        representation: def.representation,
        activeTotal: byFamily[family] || zero,
        ledgerReclassificationTotal: ledgerTotal,
        includedInDenominator: false,
        description: def.description,
      };
    } else {
      families[family] = {
        authoritative: def.authoritative,
        representation: def.representation,
        activeTotal: byFamily[family] || zero,
        includedInDenominator: true,
        description: def.description,
      };
    }
    if (!def.authoritative) complete = false;
  }
  return { total, complete, families };
}

module.exports = {
  SOURCE_FAMILIES,
  createForPendingWithdrawal,
  releaseOnSettlement,
  cancelOnReversal,
  authoritativeTotals,
};
