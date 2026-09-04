const { PosOrderService } = require('../services/businessOS/posOrderService');

describe('PosOrderService atomic settlement', () => {
    const defaultProduct = { id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null, isActive: true, isAvailable: true };

    function baseTx(overrides = {}) {
        return {
            user: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ azmBalance: 59 }),
            },
            azmSpendLog: { create: jest.fn().mockResolvedValue({}) },
            businessOrder: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'order-1', businessProfileId: 'biz-1', cashChange: 0, amountUsdc: 41 }),
            },
            businessOrderItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue(defaultProduct),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
            inventoryItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            ...overrides,
        };
    }

    test('re-derives catalog prices from the transaction client and commits balance, line items, order and ledger together', async () => {
        const tx = baseTx();
        const prisma = {
            businessProduct: { findFirst: jest.fn(() => { throw new Error('catalog must be read through transaction client'); }) },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        const result = await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 2 }], paymentMethod: 'AZM', idempotencyKey: 'pos-1',
        });

        expect(result.computedGrand).toBe(41);
        expect(tx.businessProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'prod-1', businessProfileId: 'biz-1', isActive: true, isAvailable: true, locationId: null },
        }));
        expect(tx.user.updateMany).toHaveBeenCalledWith({
            where: { id: 7, azmBalance: { gte: 41 } },
            data: { azmBalance: { decrement: 41 } },
        });
        expect(tx.azmSpendLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ userId: 7, amount: 41, balanceAfter: 59 }),
        }));
        expect(tx.businessOrderItem.createMany).toHaveBeenCalledWith({
            data: [{ orderId: 'order-1', productId: 'prod-1', name: 'Meal', unitPrice: 20, quantity: 2, lineTotal: 40 }],
        });
        expect(tx.businessOrder.create).toHaveBeenCalled();
        expect(tx.businessLedgerEntry.create).toHaveBeenCalled();
    });

    test('uses transaction-time catalog state for availability and pricing', async () => {
        const tx = baseTx({
            businessProduct: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Stale quote', priceUsdc: 1, stockQty: null }) },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, idempotencyKey: 'catalog-race-1',
        })).rejects.toThrow('Invalid or unavailable global product: prod-1');
        expect(prisma.businessProduct.findFirst).not.toHaveBeenCalled();
        expect(tx.businessOrder.create).not.toHaveBeenCalled();
    });

    test('computes the legacy 2.5% POS tax and cash change server-side', async () => {
        const tx = baseTx({
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'order-cash', amountUsdc: 20.5, cashChange: 4.5 }) },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        const result = await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 25, idempotencyKey: 'cash-1',
        });

        expect(result.computedSubtotal).toBe(20);
        expect(result.computedTax).toBe(0.5);
        expect(result.computedGrand).toBe(20.5);
        expect(result.change).toBe(4.5);
        expect(tx.businessOrder.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountUsdc: 20.5, cashReceived: 25, cashChange: 4.5 }) }));
    });
});
