'use strict';

class InventoryRestockService {
    constructor(prisma) { this.prisma = prisma; }

    async restock({ businessProfileId, itemId, quantity, costPerUnit }) {
        if (!businessProfileId) throw new Error('Business context required.');
        const qty = Number(quantity);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('quantity must be a positive number.');

        const item = await this.prisma.inventoryItem.findFirst({
            where: { id: itemId, businessProfileId },
            select: { id: true, name: true, unit: true, costPerUnit: true, isActive: true },
        });
        if (!item) throw new Error('Item not found.');
        if (item.isActive === false) throw new Error('Inventory item is inactive.');

        const unitCost = costPerUnit == null ? Number(item.costPerUnit) : Number(costPerUnit);
        if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error('costPerUnit must be a non-negative number.');
        const totalCostGhs = unitCost * qty;

        const result = await this.prisma.$transaction(async (tx) => {
            const updated = await tx.inventoryItem.update({
                where: { id: item.id },
                data: { currentStock: { increment: qty }, costPerUnit: unitCost },
            });
            await tx.businessLedgerEntry.create({
                data: {
                    businessProfileId,
                    type: 'EXPENSE',
                    category: 'SUPPLIES',
                    description: `Restock: ${item.name} (x${qty} ${item.unit})`,
                    amount: -totalCostGhs,
                    sourceType: 'INVENTORY_RESTOCK',
                    sourceId: item.id,
                    metadata: { inventoryItemId: item.id, quantity: qty, unitCost },
                },
            });
            return updated;
        });

        return { item: result, totalCostGhs, ledgerWritten: true };
    }
}

module.exports = { InventoryRestockService };
