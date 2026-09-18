// §P.5-B — authoritative USDC inventory-lot substrate (acquisition + consumption)
//
// AUTHORITY: InventoryLot/InventoryLotConsumption are the ONLY inventory
// authority. CorporatePurchaseLog remains an untouched audit trail — it has
// no lot identity, remaining quantity, cost basis or evidence linkage and is
// never read or rewritten by this service.
//
// LEDGER BOUNDARY: acquisition posts through ledgerService.post() under the
// P5-A asset-identity contract (single-asset USDC, inventory:usdc:lots).
// Consumption is recorded on the lot substrate ONLY: its ledger recognition
// (COGS / pnl:inventory realization) is deferred to P5-E settlement — a
// quote/rate is never realized economics, and no P&L is recognized here.
// Invariant in this slice: ledger inventory:usdc:lots balance == sum(lot
// quantityOriginal); consumption records reserve allocation, they do not
// post.
//
// CONCURRENCY: consumption is an atomic DB claim —
//   updateMany({ where: { id, status: 'OPEN', quantityRemaining: { gte: q } } })
// Two racers can never allocate the same remaining quantity; a loser gets
// count 0 and the enclosing transaction rolls back untouched. No
// read-then-write application logic guards money.

const { Prisma } = require('@prisma/client');
const ledger = require('./ledgerService');
const logger = require('../src/config/logger');

class InventoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    if (details) this.details = details;
  }
}

// Exact positive quantity: reuses the ledger's exact-decimal authority, then
// rejects zero. Negatives, NaN, exponent notation, >8dp all fail closed there.
function exactPositive(value, label) {
  const d = ledger.toExactDecimal(value, label);
  if (d.isZero()) throw new InventoryError('INVENTORY_INVALID_QUANTITY', `${label}: must be > 0`);
  return d;
}

function keyString(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new InventoryError('INVENTORY_INVALID_KEY', `${label}: required string (<= ${max} chars)`);
  }
  return value.trim();
}

// Replay-verify an already-committed acquisition against its claimed payload:
// exact match returns the committed lot (replayed); any mismatch fails closed.
function assertAcquisitionMatch(lot, params) {
  const same = lot.sourceType === params.sourceType
    && lot.sourceReference === params.sourceReference
    && new Prisma.Decimal(lot.quantityOriginal).eq(params.quantity)
    && new Prisma.Decimal(lot.costBasisGhs).eq(params.costBasisGhs)
    && (params.acquisitionRate == null
      ? lot.acquisitionRate == null
      : lot.acquisitionRate != null && new Prisma.Decimal(lot.acquisitionRate).eq(params.acquisitionRate));
  if (!same) {
    throw new InventoryError('INVENTORY_ACQUISITION_CONFLICT',
      `acquisitionKey "${params.acquisitionKey}" already committed with different economics — fail closed`,
      { committed: { sourceType: lot.sourceType, quantityOriginal: String(lot.quantityOriginal), costBasisGhs: String(lot.costBasisGhs) } });
  }
}

/**
 * Acquire an inventory lot: immutable USDC quantity/cost event + authoritative
 * inventory:usdc:lots ledger posting. Idempotent on acquisitionKey.
 * @param tx Prisma transaction/client
 * @returns { lot, ledgerTransaction, replayed }
 */
async function acquireLot(tx, params) {
  const acquisitionKey = keyString(params.acquisitionKey, 'acquisitionKey', 140);
  const sourceType = keyString(params.sourceType, 'sourceType', 40);
  const sourceReference = keyString(params.sourceReference, 'sourceReference', 140);
  const quantity = exactPositive(params.quantity, 'quantity');
  const costBasisGhs = exactPositive(params.costBasisGhs, 'costBasisGhs');
  const acquisitionRate = params.acquisitionRate == null ? null : exactPositive(params.acquisitionRate, 'acquisitionRate');

  const existing = await tx.inventoryLot.findUnique({ where: { acquisitionKey } });
  if (existing) {
    assertAcquisitionMatch(existing, { sourceType, sourceReference, quantity, costBasisGhs, acquisitionRate });
    return { lot: existing, replayed: true };
  }

  // Authoritative inventory accounting: USDC single-asset posting through the
  // P5-A contract. equity:treasury is the catalog-only counterpart until the
  // P5-D/E GHS-liquidity provenance defines the real acquisition economics.
  const posted = await ledger.post(tx, {
    idempotencyKey: `inv:acquire:${acquisitionKey}`,
    entryType: 'INVENTORY_ACQUISITION',
    description: `inventory lot ${acquisitionKey}: ${sourceType} ${sourceReference}`,
    lines: [
      { account: 'inventory:usdc:lots', debit: quantity.toFixed(8) },
      { account: 'equity:treasury', credit: quantity.toFixed(8) },
    ],
  });

  const lot = await tx.inventoryLot.create({
    data: {
      acquisitionKey,
      sourceType,
      sourceReference,
      quantityOriginal: quantity.toFixed(8),
      quantityRemaining: quantity.toFixed(8),
      costBasisGhs: costBasisGhs.toFixed(8),
      acquisitionRate: acquisitionRate ? acquisitionRate.toFixed(8) : null,
      ledgerTxnId: posted.transaction.id,
      status: 'OPEN',
    },
  });
  logger.info({ acquisitionKey, lotId: lot.id, ledgerTxnId: posted.transaction.id, quantity: quantity.toFixed(8) }, '[inventory] lot acquired');
  return { lot, replayed: false };
}

// Replay-verify a committed consumption. Exact match returns it; mismatch fails.
function assertConsumptionMatch(c, params) {
  const same = c.lotId === params.lotId
    && new Prisma.Decimal(c.quantity).eq(params.quantity)
    && c.purpose === params.purpose
    && (c.sourceReference ?? null) === (params.sourceReference ?? null);
  if (!same) {
    throw new InventoryError('INVENTORY_CONSUMPTION_CONFLICT',
      `consumptionKey "${params.consumptionKey}" already committed with different economics — fail closed`);
  }
}

/**
 * Consume (allocate) an exact quantity from a lot. Atomic DB claim —
 * concurrent consumers cannot double-allocate; insufficient remaining fails
 * closed and leaves the enclosing transaction rollback-safe.
 * Records the durable consumption movement; NO ledger posting (P5-E realizes
 * economics at settlement). Idempotent on consumptionKey.
 * @returns { consumption, lot, replayed }
 */
async function consumeLot(tx, params) {
  const consumptionKey = keyString(params.consumptionKey, 'consumptionKey', 140);
  const purpose = keyString(params.purpose, 'purpose', 40);
  const lotId = params.lotId;
  if (!Number.isInteger(lotId) || lotId <= 0) throw new InventoryError('INVENTORY_INVALID_LOT_ID', 'lotId: required positive integer');
  const quantity = exactPositive(params.quantity, 'quantity');
  const sourceReference = params.sourceReference == null ? null : keyString(params.sourceReference, 'sourceReference', 140);

  const existing = await tx.inventoryLotConsumption.findUnique({ where: { consumptionKey } });
  if (existing) {
    assertConsumptionMatch(existing, { lotId, quantity, purpose, sourceReference });
    const lot = await tx.inventoryLot.findUnique({ where: { id: lotId } });
    return { consumption: existing, lot, replayed: true };
  }

  // Atomic claim (updateMany): the ONLY concurrency authority. A row is only
  // decremented while it is OPEN with sufficient remaining, inside this tx.
  const claimed = await tx.inventoryLot.updateMany({
    where: { id: lotId, status: 'OPEN', quantityRemaining: { gte: quantity.toFixed(8) } },
    data: { quantityRemaining: { decrement: quantity.toFixed(8) } },
  });
  if (claimed.count === 0) {
    const lot = await tx.inventoryLot.findUnique({ where: { id: lotId } });
    if (!lot) throw new InventoryError('INVENTORY_LOT_NOT_FOUND', `lot ${lotId} does not exist`);
    if (lot.status !== 'OPEN') throw new InventoryError('INVENTORY_LOT_NOT_OPEN', `lot ${lotId} is ${lot.status}`);
    throw new InventoryError('INVENTORY_INSUFFICIENT_REMAINING',
      `lot ${lotId}: remaining ${new Prisma.Decimal(lot.quantityRemaining).toFixed(8)} < requested ${quantity.toFixed(8)}`,
      { lotId, remaining: String(lot.quantityRemaining), requested: quantity.toFixed(8) });
  }

  // Exhausted lots close deterministically; partial consumption keeps OPEN.
  await tx.inventoryLot.updateMany({ where: { id: lotId, quantityRemaining: 0 }, data: { status: 'CONSUMED' } });

  const consumption = await tx.inventoryLotConsumption.create({
    data: { consumptionKey, lotId, quantity: quantity.toFixed(8), purpose, sourceReference },
  });
  const lot = await tx.inventoryLot.findUnique({ where: { id: lotId } });
  logger.info({ consumptionKey, lotId, quantity: quantity.toFixed(8), remaining: String(lot.quantityRemaining) }, '[inventory] lot consumption recorded');
  return { consumption, lot, replayed: false };
}

module.exports = { acquireLot, consumeLot, InventoryError };
