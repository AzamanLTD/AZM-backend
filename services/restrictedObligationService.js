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
const SOURCE_FAMILIES = {
  PENDING_FIAT_WITHDRAWAL:   { authoritative: true,  description: 'Customer funds reserved for a PENDING MTN MoMo payout (settled/reversed only on provider outcome).' },
  PENDING_CRYPTO_WITHDRAWAL: { authoritative: true,  description: 'Customer funds reserved for a PENDING on-chain withdrawal (CustodyExecution).' },
  ESCROW_LOCK:               { authoritative: false, description: 'P2P/SmartEscrow/booking/vault/susu restricted funds — §P.4 wave-2 migration.' },
  DISPUTE_ESCROW:             { authoritative: false, description: 'Dispute-locked customer funds — §P.4 wave-2 migration.' },
  VENDOR_UNALLOCATED:         { authoritative: false, description: 'Vendor pool allocations — §P.4 wave-2 migration.' },
};

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
    families[family] = { authoritative: def.authoritative, activeTotal: byFamily[family] || zero, description: def.description };
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
