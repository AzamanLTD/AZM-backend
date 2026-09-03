const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');

describe('InventoryRestockService', () => {
    test('updates stock and records expense in the same transaction', async () => {
        const tx = {
            inventoryItem: { update: jest.fn().mockResolvedValue({ id: 'item-1', currentStock: 15, costPerUnit: 4 }) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
        };
        const prisma = {
            inventoryItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-1', name: 'Rice', unit: 'kg', costPerUnit: 4, isActive: true }) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        const result = await new InventoryRestockService(prisma).restock({ businessProfileId: 'biz-1', itemId: 'item-1', quantity: 5 });

        expect(tx.inventoryItem.update).toHaveBeenCalledWith({ where: { id: 'item-1' }, data: { currentStock: { increment: 5 }, costPerUnit: 4 } });
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ businessProfileId: 'biz-1', type: 'EXPENSE', amount: -20 }),
        }));
        expect(result.ledgerWritten).toBe(true);
    });

    test('rolls the transaction boundary back when ledger creation fails', async () => {
        const ledgerError = new Error('ledger unavailable');
        const tx = {
            inventoryItem: { update: jest.fn().mockResolvedValue({ id: 'item-1', currentStock: 15, costPerUnit: 4 }) },
            businessLedgerEntry: { create: jest.fn().mockRejectedValue(ledgerError) },
        };
        const prisma = {
            inventoryItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-1', name: 'Rice', unit: 'kg', costPerUnit: 4, isActive: true }) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await expect(new InventoryRestockService(prisma).restock({ businessProfileId: 'biz-1', itemId: 'item-1', quantity: 5 }))
            .rejects.toThrow('ledger unavailable');
        expect(tx.inventoryItem.update).toHaveBeenCalledTimes(1);
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid quantity before mutation', async () => {
        const prisma = { inventoryItem: { findFirst: jest.fn() }, $transaction: jest.fn() };
        await expect(new InventoryRestockService(prisma).restock({ businessProfileId: 'biz-1', itemId: 'item-1', quantity: 0 }))
            .rejects.toThrow('quantity must be a positive number.');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
