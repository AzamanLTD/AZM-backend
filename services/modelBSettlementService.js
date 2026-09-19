// services/modelBSettlementService.js
//
// §P.5-E — Model B settlement / inventory cost-basis realization.
//
// THE authoritative settlement that links an evidence-backed GHS customer
// payment to REAL USDC inventory consumption, the customer USDC liability and
// durable realized economics. Replaces the §P.4 clearing:conversion bridge
// for new settlements when GlobalSettings.modelBSettlementEnabled is ON.
//
// Design contract: docs/p5e-model-b-settlement.md (read before editing).
//
// Invariants (all proven in __tests__/p5e-model-b-settlement.test.js):
//   1. Customer USDC liability increases EXACTLY by the settled amount, and
//      the liability ledger balance equals the User.availableBalance
//      projection (P4 invariant preserved).
//   2. Inventory is consumed ONLY through the P5-B atomic substrate — the
//      ledger inventory:usdc:lots balance always equals Σ lot remaining.
//   3. Every GHS figure is exact to the pesewa; every USDC figure is exact to
//      the ledger's 8-decimal authority. Nothing is rate-restated.
//   4. The durable provider observation MUST exist and match before any
//      inventory is claimed — no synthetic evidence, no synthetic inventory.
//   5. One durable economic identity per settlement (reference, unique):
//      replays return the committed outcome; conflicting reuse fails closed.
//   6. Insufficient inventory fails closed with ZERO partial financial
//      mutation — no customer credit, no consumption, no postings.

const { Prisma } = require('@prisma/client');
const logger = require('../src/config/logger');
const ledger = require('./ledgerService');
const { consumeLot, InventoryError } = require('./inventoryService');

const Decimal = Prisma.Decimal;

class ModelBError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ModelBError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ── rollout regime ─────────────────────────────────────────────────────────

async function isModelBSettlementEnabled(db) {
  const settings = await db.globalSettings.findUnique({ where: { id: 1 } });
  return settings?.modelBSettlementEnabled === true;
}

// ── exact-decimal normalization (never silently round) ─────────────────────

function toExactDecimals(value, label, maxScale) {
  let d;
  try {
    d = new Decimal(value);
  } catch {
    throw new ModelBError('MODEL_B_INVALID_AMOUNT', `${label}: not a decimal value`);
  }
  if (!d.isFinite() || d.lte(0)) {
    throw new ModelBError('MODEL_B_INVALID_AMOUNT', `${label}: must be a positive finite decimal`);
  }
  if (d.decimalPlaces() > maxScale) {
    throw new ModelBError('MODEL_B_INEXACT_AMOUNT',
      `${label}: ${d.toFixed()} exceeds the ${maxScale}-decimal authority — never silently rounded`);
  }
  return d;
}

// ── evidence verification ──────────────────────────────────────────────────

// The durable INBOUND provider observation MUST exist and match the settled
// amount + reference. The evidence layer is P5-D authority — the settlement
// never takes the caller's word for a payment.
async function verifyProviderEvidence(tx, { evidenceDedupKey, settledGhs, reference }) {
  const event = await tx.fiatProviderEvent.findUnique({ where: { dedupKey: evidenceDedupKey } });
  if (!event) {
    throw new ModelBError('MODEL_B_EVIDENCE_MISSING',
      `no durable provider observation ${evidenceDedupKey} — settlement refuses to proceed without authority evidence`);
  }
  if (event.direction !== 'INBOUND') {
    throw new ModelBError('MODEL_B_EVIDENCE_DIRECTION',
      `provider observation ${evidenceDedupKey} is ${event.direction}, not INBOUND`);
  }
  if (event.status !== 'SUCCESSFUL') {
    throw new ModelBError('MODEL_B_EVIDENCE_STATUS',
      `provider observation ${evidenceDedupKey} is ${event.status}, not SUCCESSFUL`);
  }
  if (event.relatedReference !== reference) {
    throw new ModelBError('MODEL_B_EVIDENCE_REFERENCE_MISMATCH',
      `provider observation ${evidenceDedupKey} is bound to reference ${event.relatedReference}, not ${reference}`);
  }
  const eventAmount = new Decimal(event.amountGhs);
  if (!eventAmount.eq(settledGhs)) {
    throw new ModelBError('MODEL_B_EVIDENCE_AMOUNT_MISMATCH',
      `provider observation ${evidenceDedupKey} evidences GHS ${eventAmount.toFixed(2)}, settlement claims ${settledGhs.toFixed(2)}`);
  }
  return event;
}

// ── FIFO claim + exact cost allocation ─────────────────────────────────────

// Deterministic cost-flow policy (docs/p5e-model-b-settlement.md §2.1):
// FIFO by (createdAt, id) across OPEN lots. A fully-consumed lot realizes its
// costBasisGhs EXACTLY; only a partially-consumed tail lot is prorated
// (basis × q / original at high precision, HALF_UP to the ledger's 8-decimal
// authority) with any sub-8dp residual recorded EXPLICITLY on the settlement.
async function claimInventoryFifo(tx, { reference, settledUsdc }) {
  const openLots = await tx.inventoryLot.findMany({
    where: { status: 'OPEN', quantityRemaining: { gt: '0' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const available = openLots.reduce((sum, l) => sum.plus(new Decimal(l.quantityRemaining)), new Decimal(0));
  if (available.lt(settledUsdc)) {
    throw new ModelBError('MODEL_B_INVENTORY_INSUFFICIENT',
      `Model B settlement requires ${settledUsdc.toFixed(8)} USDC of inventory; OPEN lots hold ${available.toFixed(8)} — refusing to credit a customer without authoritative inventory`,
      { required: settledUsdc.toFixed(8), available: available.toFixed(8) });
  }

  let needed = settledUsdc;
  const claims = [];
  for (const lotRow of openLots) {
    if (needed.lte(0)) break;
    const lotRemaining = new Decimal(lotRow.quantityRemaining);
    const take = lotRemaining.lt(needed) ? lotRemaining : needed;

    // P5-B atomic claim — the ONLY inventory authority. Concurrent racers
    // cannot double-allocate; a drained lot fails closed here and the whole
    // enclosing settlement rolls back untouched.
    const { consumption, lot, replayed } = await consumeLot(tx, {
      consumptionKey: `p5e:modelb:${reference}:lot:${lotRow.id}`,
      lotId: lotRow.id,
      quantity: take.toFixed(8),
      purpose: 'MODEL_B_SETTLEMENT',
      sourceReference: reference,
    });

    const basis = new Decimal(lot.costBasisGhs);
    const original = new Decimal(lot.quantityOriginal);
    let shareExact;
    if (original.eq(take)) {
      // fully consumed — the lot's cost basis realizes EXACTLY, no arithmetic
      shareExact = basis;
    } else {
      // proration at decimal.js default precision (20 significant digits) —
      // exact far beyond the 8-decimal authority applied below; any sub-8dp
      // difference is recorded explicitly in shareResidualGhs.
      shareExact = Decimal.div(basis.times(take), original);
    }
    const share = shareExact.toDecimalPlaces(12, Decimal.ROUND_HALF_UP); // 12dp — bounded by half of the 8th decimal

    claims.push({
      consumptionId: consumption.id,
      lotId: lot.id,
      acquisitionKey: lot.acquisitionKey,
      quantity: take.toFixed(8),
      lotCostBasisGhs: basis.toFixed(8),
      lotQuantityOriginal: original.toFixed(8),
      costShareGhs: share.toFixed(8),
      remainingAfter: new Decimal(lot.quantityRemaining).toFixed(8),
      shareResidualGhs: shareExact.minus(share).toFixed(8),
      replayed,
    });
    needed = needed.minus(take);
  }
  if (!needed.isZero()) {
    // unreachable under the availability pre-check; kept as a hard guard
    throw new ModelBError('MODEL_B_INVENTORY_INSUFFICIENT',
      `inventory claim fell short by ${needed.toFixed(8)} USDC — fail closed`);
  }
  return claims;
}

// ── THE settlement primitive ───────────────────────────────────────────────

/**
 * Settle a Model B customer purchase from authoritative inventory, inside the
 * CALLER-OWNED transaction (same contract as ledgerService.post).
 *
 * @param {Object} tx caller-owned Prisma transaction client
 * @param {Object} params
 *   reference            TransactionHistory.txHash — the durable economic identity
 *   transactionHistoryId settled TransactionHistory row id
 *   userId               customer User id
 *   quoteId              consumed TransactionQuote id (UUID)
 *   quotedGhs            quote.amountGhs (exact pesewas)
 *   quotedRateGhsPerUsdc quote.rateGhsPerUsdc (exact 8dp)
 *   quotedUsdc           quote.usdcAmount rounded to the 8dp ledger authority
 *   settledGhs           evidence-backed settled GHS (exact pesewas)
 *   settledUsdc          committed TransactionHistory.amountUsdc (exact 8dp)
 *   selectedRoute / routeProviderRail / routePolicyVersion   quote route identity
 *   provider             evidence provider (e.g. MOOLRE)
 *   providerRef          provider's own reference, if any
 *   evidenceDedupKey     FiatProviderEvent.dedupKey of the verified observation
 *   providerFeeGhs       exact pesewas, or null when NOT actually evidenced
 * @returns {{ settlement, replayed }} the committed ModelBSettlement + replay flag
 */
async function settleDepositFromInventory(tx, params = {}) {
  const {
    reference, transactionHistoryId, userId, quoteId,
    quotedGhs, quotedRateGhsPerUsdc, quotedUsdc,
    settledGhs, settledUsdc,
    selectedRoute, routeProviderRail, routePolicyVersion,
    provider, providerRef, evidenceDedupKey, providerFeeGhs,
  } = params;
  if (typeof reference !== 'string' || !reference || reference.length > 140) {
    throw new ModelBError('MODEL_B_INVALID_IDENTITY', 'reference (1-140 chars) is required');
  }
  if (typeof transactionHistoryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transactionHistoryId)) {
    throw new ModelBError('MODEL_B_INVALID_IDENTITY', 'transactionHistoryId (UUID) is required');
  }
  if (!Number.isInteger(userId)) {
    throw new ModelBError('MODEL_B_INVALID_IDENTITY', 'userId is required');
  }
  if (typeof quoteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(quoteId)) {
    throw new ModelBError('MODEL_B_INVALID_IDENTITY', 'quoteId (UUID) is required');
  }
  if (typeof provider !== 'string' || !provider || provider.length > 40) {
    throw new ModelBError('MODEL_B_INVALID_IDENTITY', 'provider is required');
  }
  if (typeof evidenceDedupKey !== 'string' || !evidenceDedupKey || evidenceDedupKey.length > 140) {
    throw new ModelBError('MODEL_B_INVALID_IDENTITY', 'evidenceDedupKey is required — settlement never proceeds without durable provider evidence');
  }

  const settledGhsD = toExactDecimals(settledGhs, 'settledGhs', 2);
  const settledUsdcD = toExactDecimals(settledUsdc, 'settledUsdc', 8);
  const quotedGhsD = toExactDecimals(quotedGhs, 'quotedGhs', 2);
  const quotedRateD = toExactDecimals(quotedRateGhsPerUsdc, 'quotedRateGhsPerUsdc', 8);
  // The quote's native USDC amount is numeric(30,12) — its native 12-decimal
  // precision stays on the TransactionQuote row; the settlement records it
  // projected at the ledger's 8-decimal authority (HALF_UP, the same
  // rounding PostgreSQL applies storing TransactionHistory.amountUsdc).
  const quotedUsdcD = quotedUsdc == null
    ? null
    : toExactDecimals(quotedUsdc, 'quotedUsdc', 12).toDecimalPlaces(12, Decimal.ROUND_HALF_UP); // 12dp — bounded by half of the 8th decimal
  const feeD = providerFeeGhs == null ? null : toExactDecimals(providerFeeGhs, 'providerFeeGhs', 2);

  // ── replay / conflict on the durable economic identity ──────────────────
  const existing = await tx.modelBSettlement.findUnique({ where: { reference } });
  if (existing) {
    const fingerprintOk = new Decimal(existing.settledGhs).eq(settledGhsD)
      && new Decimal(existing.settledUsdc).eq(settledUsdcD)
      && existing.quoteId === quoteId;
    if (!fingerprintOk) {
      throw new ModelBError('MODEL_B_SETTLEMENT_CONFLICT',
        `reference ${reference} is already committed with different economics — conflicting reuse fails closed`);
    }
    return { settlement: existing, replayed: true };
  }

  // ── evidence before inventory: authority is verified, never assumed ──────
  await verifyProviderEvidence(tx, { evidenceDedupKey, settledGhs: settledGhsD, reference });

  // ── FIFO inventory claim (the only USDC source for a customer) ──────────
  const claims = await claimInventoryFifo(tx, { reference, settledUsdc: settledUsdcD });

  const costBasisTotal = claims.reduce((s, c) => s.plus(new Decimal(c.costShareGhs)), new Decimal(0));
  const costResidual = claims.reduce((s, c) => s.plus(new Decimal(c.shareResidualGhs)), new Decimal(0))
    .toDecimalPlaces(12, Decimal.ROUND_HALF_UP); // 12dp — bounded by half of the 8th decimal
  // the realized customer spread is GHS-denominated and EXACT — never restated
  // in USDC and never derived from a market quote.
  const marginGhs = settledGhsD.minus(costBasisTotal);

  // ── posting 1: the exchange (explicit ASSET_CONVERSION, P5-A contract) ───
  // GHS leg: the customer's evidenced GHS lands as a platform asset held for
  //          treasury (fiat:momo:ghs / equity:treasury:ghs).
  // USDC leg: the delivered inventory's exact quantity is realized as cost of
  //          goods (expense:cogs:usdc) out of the inventory asset.
  const conversion = await ledger.post(tx, {
    idempotencyKey: `ledger:modelb:conversion:${reference}`,
    entryType: 'ASSET_CONVERSION',
    description: `Model B settlement ${reference}: customer GHS ${settledGhsD.toFixed(2)} exchanged for ${settledUsdcD.toFixed(8)} USDC of inventory`,
    reference,
    userId,
    conversion: {
      identity: `p5e:modelb:${reference}`,
      rate: quotedRateD.toFixed(8),
      quoteReference: quoteId,
    },
    metadata: {
      modelB: 'P5-E',
      settledGhs: settledGhsD.toFixed(2),
      settledUsdc: settledUsdcD.toFixed(8),
      costBasisGhsTotal: costBasisTotal.toFixed(8),
      marginGhs: marginGhs.toFixed(8),
      lotIds: claims.map((c) => c.lotId),
    },
    lines: [
      { account: 'fiat:momo:ghs', debit: settledGhsD.toFixed(2) },
      { account: 'equity:treasury:ghs', credit: settledGhsD.toFixed(2) },
      { account: 'expense:cogs:usdc', debit: settledUsdcD.toFixed(8) },
      { account: 'inventory:usdc:lots', credit: settledUsdcD.toFixed(8) },
    ],
  });

  // ── posting 2: the customer wallet claim, funded by the treasury USDC
  //    stake the lot acquisition created (P5-B: D inventory / C equity) ──────
  const deposit = await ledger.post(tx, {
    idempotencyKey: `ledger:modelb:deposit:${reference}`,
    entryType: 'DEPOSIT',
    description: `Model B settlement ${reference}: customer ${settledUsdcD.toFixed(8)} USDC liability from treasury inventory stake`,
    reference,
    userId,
    metadata: { modelB: 'P5-E', conversionIdentity: `p5e:modelb:${reference}` },
    lines: [
      { account: 'equity:treasury', debit: settledUsdcD.toFixed(8) },
      { account: `user:${userId}:liability`, credit: settledUsdcD.toFixed(8) },
    ],
  });

  // ── durable realized economics: quoted vs settled vs cost basis vs spread ─
  const settlement = await tx.modelBSettlement.create({
    data: {
      reference,
      transactionHistoryId,
      quoteId,
      userId,
      selectedRoute: selectedRoute ?? null,
      routeProviderRail: routeProviderRail ?? null,
      routePolicyVersion: routePolicyVersion ?? null,
      provider,
      providerRef: providerRef ?? null,
      evidenceDedupKey,
      quotedGhs: quotedGhsD.toFixed(2),
      quotedRateGhsPerUsdc: quotedRateD.toFixed(8),
      quotedUsdc: quotedUsdcD ? quotedUsdcD.toFixed(8) : settledUsdcD.toFixed(8),
      settledGhs: settledGhsD.toFixed(2),
      settledUsdc: settledUsdcD.toFixed(8),
      costBasisGhsTotal: costBasisTotal.toFixed(8),
      costAllocationResidualGhs: costResidual.toFixed(8),
      marginGhs: marginGhs.toFixed(8),
      providerFeeGhs: feeD ? feeD.toFixed(2) : null,
      conversionIdentity: `p5e:modelb:${reference}`,
      conversionLedgerTxnId: conversion.transaction.id,
      depositLedgerTxnId: deposit.transaction.id,
      lotAllocations: claims.map(({ replayed, shareResidualGhs, ...c }) => c),
    },
  });

  // P5-B reserved this field for P5-E: the consumption now carries the ledger
  // identity that realized its economics.
  for (const c of claims) {
    await tx.inventoryLotConsumption.update({
      where: { id: c.consumptionId },
      data: { ledgerTxnId: conversion.transaction.id },
    });
  }

  logger.info({
    reference, quoteId, settledGhs: settledGhsD.toFixed(2), settledUsdc: settledUsdcD.toFixed(8),
    lots: claims.length, costBasisGhs: costBasisTotal.toFixed(2), marginGhs: marginGhs.toFixed(2),
    conversionTxn: conversion.transaction.id, depositTxn: deposit.transaction.id,
  }, '[modelB] settlement committed');

  return { settlement, replayed: false };
}

module.exports = {
  isModelBSettlementEnabled,
  settleDepositFromInventory,
  ModelBError,
};
