const { PosOrderService } = require('../services/businessOS/posOrderService');

describe('PosOrderService location/table/product boundaries', () => {
    function tx(overrides = {}) {
        return {
            businessOrder: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'order-1', amountUsdc: 20.5, cashChange: 0, businessProfileId: 'biz-1' }),
            },
            businessLocation: { findFirst: jest.fn().mockResolvedValue({ id: 'loc-1' }) },
            businessTable: { findFirst: jest.fn().mockResolvedValue({ id: 'table-1' }) },
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
            inventoryItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            businessOrderItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
            user: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ azmBalance: 100 }),
            },
            azmSpendLog: { create: jest.fn().mockResolvedValue({}) },
            ...overrides,
        };
    }

    test('rejects tableId without locationId', async () => {
        const transaction = tx();
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(transaction)) };
        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, tableId: 'table-1', idempotencyKey: 'ctx-1',
        })).rejects.toThrow('tableId requires locationId.');
    });

    test('requires the requested location to belong to the current business and be active', async () => {
        const transaction = tx({ businessLocation: { findFirst: jest.fn().mockResolvedValue(null) } });
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(transaction)) };
        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, locationId: 'loc-2', idempotencyKey: 'ctx-2',
        })).rejects.toThrow('Invalid or inactive business location.');
        expect(transaction.businessLocation.findFirst).toHaveBeenCalledWith({
            where: { id: 'loc-2', businessProfileId: 'biz-1', isActive: true },
            select: { id: true },
        });
        expect(transaction.businessTable.findFirst).not.toHaveBeenCalled();
    });

    test('requires the table to belong to the exact requested location', async () => {
        const transaction = tx({ businessTable: { findFirst: jest.fn().mockResolvedValue(null) } });
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(transaction)) };
        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, locationId: 'loc-1', tableId: 'table-2', idempotencyKey: 'ctx-3',
        })).rejects.toThrow('Invalid or inactive business table for location.');
        expect(transaction.businessTable.findFirst).toHaveBeenCalledWith({
            where: { id: 'table-2', locationId: 'loc-1', isActive: true },
            select: { id: true },
        });
        expect(transaction.businessOrder.create).not.toHaveBeenCalled();
    });

    test('only accepts globally available or exact-branch products when a location is supplied', async () => {
        const transaction = tx({
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        });
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(transaction)) };
        await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, locationId: 'loc-1', idempotencyKey: 'ctx-4',
        });
        expect(transaction.businessProduct.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'prod-1',
                businessProfileId: 'biz-1',
                isActive: true,
                isAvailable: true,
                OR: [{ locationId: null }, { locationId: 'loc-1' }],
            },
            select: { id: true, name: true, priceUsdc: true, stockQty: true },
        });
    });

    test('normalizes numeric customerId and preserves it for cash orders after context validation', async () => {
        const transaction = tx({ user: {
            updateMany: jest.fn(),
            findUnique: jest.fn().mockResolvedValueOnce({ id: 42 }),
        } });
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(transaction)) };
        await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, customerId: '42', idempotencyKey: 'ctx-5',
        });
        expect(transaction.businessOrder.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ customerId: 42 }) }));
    });
});
