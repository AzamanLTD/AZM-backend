'use strict';

const { createHash, randomUUID } = require('crypto');

function restockError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
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
        const qty = Number(quantity);
        if (quantity == null || quantity === '' || !Number.isFinite(qty) || qty <= 0)
            throw restockError('RESTOCK_INVALID_QUANTITY', 'quantity must be a positive number.');
        const hasExplicitCost = costPerUnit !== null && costPerUnit !== undefined;
        const suppliedCost = hasExplicitCost ? Number(costPerUnit) : null;
        if (hasExplicitCost && (costPerUnit === '' || !Number.isFinite(suppliedCost) || suppliedCost < 0))
            throw restockError('RESTOCK_INVALID_COST', 'costPerUnit must be a non-negative number.');

        // Fingerprint only caller-controlled economics. In particular, do NOT
        // include catalog cost, stock or active status: replay must survive
        // subsequent catalog changes without re-executing the operation.
        const fingerprint = createHash('sha256').update(JSON.stringify([
            businessProfileId, itemId, qty, hasExplicitCost ? suppliedCost : 'DEFAULT_COST',
        ])).digest('hex');
        const identity = { businessProfileId_idempotencyKey: { businessProfileId, idempotencyKey } };
        const replay = async () => {
            const committed = await this.prisma.inventoryRestockOperation.findUnique({ where: identity });
            if (!committed) return null;
            if (committed.requestFingerprint !== fingerprint)
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
                    data: { id: randomUUID(), businessProfileId, itemId, idempotencyKey, requestFingerprint: fingerprint },
                });
                const item = await tx.inventoryItem.findFirst({
                    where: { id: itemId, businessProfileId },
                    select: { id: true, name: true, unit: true, costPerUnit: true, isActive: true },
                });
                if (!item) throw restockError('RESTOCK_ITEM_NOT_FOUND', 'Item not found.', 404);
                if (!item.isActive) throw restockError('RESTOCK_ITEM_INACTIVE', 'Inventory item is inactive.');
                const unitCost = hasExplicitCost ? suppliedCost : Number(item.costPerUnit);
                const totalCostGhs = unitCost * qty;
                if (!Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(totalCostGhs) || totalCostGhs > 1e12)
                    throw restockError('RESTOCK_INVALID_COST', 'Restock cost is invalid.');
                const updated = await tx.inventoryItem.update({
                    where: { id: item.id },
                    data: { currentStock: { increment: qty }, costPerUnit: unitCost },
                });
                const ledger = await tx.businessLedgerEntry.create({
                    data: {
                        businessProfileId, type: 'EXPENSE', category: 'SUPPLIES',
                        description: `Restock: ${item.name} (x${qty} ${item.unit})`,
                        amount: -totalCostGhs, amountGhs: -totalCostGhs,
                        sourceType: 'INVENTORY_RESTOCK', sourceId: operation.id,
                        metadata: { inventoryItemId: item.id, quantity: qty, unitCost, operationId: operation.id },
                    },
                });
                // Store the exact wire response; later catalog/stock changes
                // must not change the response for this committed operation.
                const result = JSON.parse(JSON.stringify({ item: updated, totalCostGhs, ledgerWritten: true, operationId: operation.id }));
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
