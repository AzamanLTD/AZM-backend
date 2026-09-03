const { PosOrderService } = require('../services/businessOS/posOrderService');

describe('PosOrderService atomic settlement', () => {
    test('re-derives catalog prices and commits balance, order and ledger together', async () => {
        const tx = {
            user: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ azmBalance: 59 }),
            },
            azmSpendLog: { create: jest.fn().mockResolvedValue({}) },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'order-1', businessProfileId: 'biz-1', cashChange: 0 }) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
        };
        const prisma = {
            businessProduct: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20 }) },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        const result = await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1',
            actorId: 7,
            items: [{ productId: 'prod-1', quantity: 2 }],
            paymentMethod: 'AZM',
            idempotencyKey: 'pos-1',
        });

        expect(result.computedGrand).toBe(41);
        expect(tx.user.updateMany).toHaveBeenCalledWith({
            where: { id: 7, azmBalance: { gte: 41 } },
            data: { azmBalance: { decrement: 41 } },
        });
        expect(tx.azmSpendLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ userId: 7, amount: 41, balanceAfter: 59 }),
        }));
        expect(tx.businessOrder.create).toHaveBeenCalled();
        expect(tx.businessLedgerEntry.create).toHaveBeenCalled();
    });

    test('rejects an idempotency key owned by another business', async () => {
        const prisma = {
            businessProduct: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20 }) },
            businessOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-other', businessProfileId: 'biz-2' }) },
            $transaction: jest.fn(),
        };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 21, idempotencyKey: 'same-key',
        })).rejects.toThrow('Idempotency key already belongs to another business.');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
