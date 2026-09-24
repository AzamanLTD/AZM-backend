'use strict';

const { createHash, randomUUID } = require('crypto');
const { Prisma } = require('@prisma/client');

function restockError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

// §Wave-1B exact-decimal economics. Binary floats are NOT the economic
// authority for restocking: 0.1 * 3 must post exactly 0.3 GHS to the ledger,
// not 0.30000000000000004. Restock quantities and GHS unit costs accept at
// most 8 decimal places (the ledger's own Decimal(20, 8) scale), magnitude
// bounds per field below. JSON numbers are accepted as-is (the JSON layer
// already rejected NaN/Infinity); strings must be plain decimal literals —
// no exponents, hex, whitespace, or booleans — anything else is malformed
// and rejected. All internal arithmetic runs on Prisma.Decimal; the only
// binary float left in a restock is the legacy Float catalog projection
// (currentStock/costPerUnit columns), which is stored state, not math.
const MAX_ECONOMIC_MAGNITUDE = new Prisma.Decimal('1000000000000'); // 1e12
const MAX_ECONOMIC_DP = 8;
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

// §r34 — POSTING-UNIT CONTRACT. The ledger (BusinessLedgerEntry.amount /
// amountGhs) is Decimal(20, 8): its smallest representable unit is
// GHS 0.00000001. The exact product of two ≤8dp operands can carry up to 16
// decimal places, so the ledger CAN silently round a non-zero total to zero
// (e.g. 0.00000001 × 0.00000001 = 0.0000000000000001). That would record a
// real economic event as a zero posting — unacceptable. The documented
// contract is therefore:
//   • an exact total of EXACTLY ZERO (zero-cost restock) is fine — the
//     zero posting is the truth;
//   • a NON-ZERO exact total smaller than LEDGER_UNIT is REJECTED
//     (RESTOCK_TOTAL_UNREPRESENTABLE) — fail closed instead of rounding
//     real economics away to zero;
//   • a non-zero total ≥ LEDGER_UNIT is accepted and posted as the exact
//     product rounded half-away-from-zero to 8dp (the database's NUMERIC
//     semantics); the FULL exact product is preserved in the ledger row's
//     metadata (totalCostGhs exact string + postedAmountGhs) and in the
//     response, so the rounding is always explicit, never silent.
const LEDGER_UNIT = new Prisma.Decimal('0.00000001');

// Fixed-notation exact string for durable evidence (decimal.js falls back
// to exponential notation for very small magnitudes, which is unreadable in
// an audit trail).
function exactString(d) {
    return d.toFixed(Math.max(0, d.decimalPlaces()));
}

// Returns an exact Prisma.Decimal or throws a restock error.
function parseExactDecimal(value, { field, minimum, strictString }) {
    let text;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw restockError('RESTOCK_INVALID_' + field, field + ' must be a finite number.');
        text = String(value); // shortest round-trip repr of the wire value
    } else if (typeof value === 'string' && strictString) {
        if (!DECIMAL_STRING.test(value)) throw restockError('RESTOCK_INVALID_' + field, field + ' must be a plain decimal number.');
        text = value;
    } else {
        throw restockError('RESTOCK_INVALID_' + field, field + ' must be a number.');
    }
    const d = new Prisma.Decimal(text);
    if (!d.isFinite()) throw restockError('RESTOCK_INVALID_' + field, field + ' is not a finite number.');
    if (d.decimalPlaces() > MAX_ECONOMIC_DP) {
        throw restockError('RESTOCK_INVALID_' + field, field + ' allows at most ' + MAX_ECONOMIC_DP + ' decimal places.');
    }
    if (d.lessThan(minimum)) throw restockError('RESTOCK_INVALID_' + field, field + ' is out of range.');
    if (d.greaterThan(MAX_ECONOMIC_MAGNITUDE)) throw restockError('RESTOCK_INVALID_' + field, field + ' is out of range.');
    return d;
}

class InventoryRestockService {
    constructor(prisma) { this.prisma = prisma; }

    async restock({ businessProfileId, itemId, quantity, costPerUnit, idempotencyKey }) {
        if (!businessProfileId) throw restockError('BUSINESS_CONTEXT_REQUIRED', 'Business context required.');
        if (typeof itemId !== 'string' || !itemId) throw restockError('RESTOCK_ITEM_REQUIRED', 'Item is required.');
        // Do not derive identity from the payload: two identical restocks can
        // represent two distinct purchases. Never allow a key to expire.
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() ||
            idempotencyKey.length > 128 || idempotencyKey !== idempotencyKey.trim() ||
            /[\x00-\x1f\x7f]/.test(idempotencyKey)) {
            throw restockError('RESTOCK_IDEMPOTENCY_KEY_REQUIRED', 'Send a nonempty Idempotency-Key (at most 128 characters).');
        }
        // Exact-decimal parsing (see §Wave-1B note above). The wire still
        // accepts JSON numbers and decimal strings; the strict-string guard
        // rejects exponents, hex, whitespace and non-numeric junk that
        // Number() would have silently coerced.
        const qty = parseExactDecimal(quantity, { field: 'QUANTITY', minimum: new Prisma.Decimal('0.00000001'), strictString: true });
        const hasExplicitCost = costPerUnit !== null && costPerUnit !== undefined;
        const suppliedCost = hasExplicitCost
            ? parseExactDecimal(costPerUnit, { field: 'COST', minimum: new Prisma.Decimal(0), strictString: true })
            : null;

        // Fingerprint only caller-controlled economics. In particular, do NOT
        // include catalog cost, stock or active status: replay must survive
        // subsequent catalog changes without re-executing the operation.
        //
        // r40 — FINGERPRINT VERSIONING. The v1 digest was computed from
        // FLOAT-NORMALIZED economics (Number(qty)); two requests that differ
        // only beyond double precision collided, so a "replay" of a different
        // purchase silently returned the first operation's result. v2 digests
        // the EXACT decimal strings. Versioning (not re-hashing) is what makes
        // the migration safe: every operation stores the version it was
        // committed under, replay verifies against THAT version, and no
        // pre-r40 operation can ever be stranded behind a 409. New operations
        // always commit under v2.
        const fingerprintV1 = createHash('sha256').update(JSON.stringify([
            businessProfileId, itemId, Number(qty.toString()), hasExplicitCost ? Number(suppliedCost.toString()) : 'DEFAULT_COST',
        ])).digest('hex');
        const fingerprint = createHash('sha256').update(JSON.stringify([
            businessProfileId, itemId, qty.toString(), hasExplicitCost ? suppliedCost.toString() : 'DEFAULT_COST',
        ])).digest('hex');
        const FINGERPRINT_VERSION = 2;
        const identity = { businessProfileId_idempotencyKey: { businessProfileId, idempotencyKey } };
        const replay = async () => {
            const committed = await this.prisma.inventoryRestockOperation.findUnique({ where: identity });
            if (!committed) return null;
            // Replay against the version the operation was COMMITTED under:
            // v1 rows verify with the legacy float digest, v2 with the exact
            // decimal digest. A row with no version is pre-r40 = v1.
            const committedVersion = committed.fingerprintVersion || 1;
            if (committed.requestFingerprint !== (committedVersion === 1 ? fingerprintV1 : fingerprint))
                throw restockError('RESTOCK_IDEMPOTENCY_CONFLICT', 'Idempotency-Key already belongs to a different restock.', 409);
            if (!committed.result || !committed.ledgerId)
                throw restockError('RESTOCK_INCOMPLETE_OPERATION', 'Restock operation is incomplete.', 409);
            return committed.result;
        };

        // A replay is checked before reading the mutable inventory catalog.
        const committed = await replay();
        if (committed) return committed;

        try {
            return await this.prisma.$transaction(async (tx) => {
                // The DB unique index is the concurrent claim. A losing insert
                // waits for the first transaction to commit or roll back; no
                // second stock/expense writes can occur before this claim.
                const operation = await tx.inventoryRestockOperation.create({
                    data: { id: randomUUID(), businessProfileId, itemId, idempotencyKey, requestFingerprint: fingerprint, fingerprintVersion: FINGERPRINT_VERSION },
                });
                const item = await tx.inventoryItem.findFirst({
                    where: { id: itemId, businessProfileId },
                    select: { id: true, name: true, unit: true, costPerUnit: true, isActive: true },
                });
                if (!item) throw restockError('RESTOCK_ITEM_NOT_FOUND', 'Item not found.', 404);
                if (!item.isActive) throw restockError('RESTOCK_ITEM_INACTIVE', 'Inventory item is inactive.');
                // Catalog cost is legacy Float storage; interpret it through its
                // shortest round-trip string, then do all math in exact decimals.
                const unitCost = hasExplicitCost
                    ? suppliedCost
                    : parseExactDecimal(item.costPerUnit, { field: 'COST', minimum: new Prisma.Decimal(0), strictString: false });
                const totalCostGhs = unitCost.mul(qty); // exact decimal product
                if (totalCostGhs.greaterThan(MAX_ECONOMIC_MAGNITUDE))
                    throw restockError('RESTOCK_INVALID_COST', 'Restock cost is invalid.');
                // §r34 posting-unit contract (see LEDGER_UNIT above): a
                // non-zero exact total below the ledger's representable unit
                // is rejected outright — it must never become a silent
                // zero-amount financial posting.
                if (!totalCostGhs.isZero() && totalCostGhs.lessThan(LEDGER_UNIT)) {
                    throw restockError(
                        'RESTOCK_TOTAL_UNREPRESENTABLE',
                        'Exact restock total (' + exactString(totalCostGhs) + ' GHS) is smaller than the ledger\u2019s smallest representable unit (GHS 0.00000001); it would round to a zero financial posting. Increase quantity or unit cost.',
                    );
                }
                // The ledger column stores the exact product rounded to 8dp
                // (NUMERIC half-away-from-zero); metadata keeps BOTH the
                // exact product and the 8dp posted amount so the rounding is
                // explicit, durable evidence rather than silent data loss.
                const postedAmountGhs = totalCostGhs.toDecimalPlaces(MAX_ECONOMIC_DP);
                const updated = await tx.inventoryItem.update({
                    where: { id: item.id },
                    data: { currentStock: { increment: qty }, costPerUnit: unitCost },
                });
                const ledger = await tx.businessLedgerEntry.create({
                    data: {
                        businessProfileId, type: 'EXPENSE', category: 'SUPPLIES',
                        description: `Restock: ${item.name} (x${qty} ${item.unit})`,
                        // Exact negation of the exact product — the ledger row
                        // (Decimal(20, 8)) is the economic authority, never a
                        // binary-float product.
                        amount: totalCostGhs.negated(), amountGhs: totalCostGhs.negated(),
                        sourceType: 'INVENTORY_RESTOCK', sourceId: operation.id,
                        metadata: {
                            inventoryItemId: item.id, operationId: operation.id,
                            quantity: exactString(qty), unitCost: exactString(unitCost),
                            totalCostGhs: exactString(totalCostGhs),
                            postedAmountGhs: exactString(postedAmountGhs),
                        },
                    },
                });
                // Store the exact wire response; later catalog/stock changes
                // must not change the response for this committed operation.
                // totalCostGhs stays a JSON number on the wire (API
                // compatibility); the exact strings live in the ledger row and
                // its metadata above.
                const result = JSON.parse(JSON.stringify({ item: updated, totalCostGhs: Number(totalCostGhs.toString()), ledgerWritten: true, operationId: operation.id }));
                await tx.inventoryRestockOperation.update({
                    where: { id: operation.id }, data: { ledgerId: ledger.id, result },
                });
                return result;
            });
        } catch (error) {
            if (error.code === 'P2002') {
                const winner = await replay();
                if (winner) return winner;
                throw restockError('RESTOCK_CLAIM_CONFLICT', 'Restock claim did not complete; retry with the same key.', 409);
            }
            throw error;
        }
    }
}

module.exports = { InventoryRestockService };
