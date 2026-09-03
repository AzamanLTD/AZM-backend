const crypto = require('crypto');
const { PosOrderService } = require('../services/businessOS/posOrderService');

function fingerprint(intent) {
    const canonical = {
        businessProfileId: String(intent.businessProfileId),
        actorId: Number(intent.actorId),
        items: [...intent.items]
            .map(({ productId, quantity }) => ({ productId: String(productId), quantity: Number(quantity) }))
            .sort((a, b) => a.productId.localeCompare(b.productId) || a.quantity - b.quantity),
        paymentMethod: String(intent.paymentMethod || 'CASH').toUpperCase(),
        cash: Number(intent.cashGiven || 0),
        requestedAzm: Number(intent.azmAmount || 0),
        source: intent.source ?? null,
        locationId: intent.locationId ?? null,
        tableId: intent.tableId ?? null,
        customerId: intent.customerId == null ? null : Number(intent.customerId),
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

describe('PosOrderService idempotency intent binding', () => {
    test('rejects reuse of a POS key for a different request intent', async () => {
        const existing = { id: 'order-1', businessProfileId: 'biz-1', amountUsdc: 20.5, cashChange: 4.5 };
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(existing) },
            businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue({ metadata: { posIdempotencyFingerprint: 'stored-fingerprint' } }) },
            businessProduct: { findFirst: jest.fn() },
            $transaction: jest.fn(),
        };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 2 }],
            paymentMethod: 'CASH', cashGiven: 50, idempotencyKey: 'same-key',
        })).rejects.toThrow('Idempotency key already used for a different POS request.');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('replays an identical POS intent even after the catalog changes', async () => {
        const intent = {
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 2 }],
            paymentMethod: 'CASH', cashGiven: 50, idempotencyKey: 'same-key',
        };
        const existing = { id: 'order-1', businessProfileId: 'biz-1', amountUsdc: 41, cashChange: 9 };
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(existing) },
            businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue({ metadata: { posIdempotencyFingerprint: fingerprint(intent) } }) },
            businessProduct: { findFirst: jest.fn() },
            $transaction: jest.fn(),
        };

        const result = await new PosOrderService(prisma).createOrder(intent);

        expect(result.duplicate).toBe(true);
        expect(result.computedGrand).toBe(41);
        expect(result.change).toBe(9);
        expect(prisma.businessProduct.findFirst).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('persists the request fingerprint in the atomic POS ledger entry', async () => {
        const tx = {
            businessOrder: {
                findFirst: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({ id: 'order-1', businessProfileId: 'biz-1', amountUsdc: 20.5, cashChange: 4.5 }),
            },
            businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
            businessProduct: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null }), updateMany: jest.fn() },
            businessOrderItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
            recipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
            inventoryItem: { updateMany: jest.fn() },
            user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue({ id: 7, azmBalance: 10 }) },
            azmSpendLog: { create: jest.fn() },
        };
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };
        const intent = {
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 25, idempotencyKey: 'new-key',
        };

        await new PosOrderService(prisma).createOrder(intent);

        expect(tx.businessLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ posIdempotencyFingerprint: fingerprint(intent) }),
            }),
        }));
    });
});
