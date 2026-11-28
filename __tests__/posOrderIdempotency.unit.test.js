const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { PosOrderService } = require('../services/businessOS/posOrderService');

// Mirrors buildIdempotencyFingerprint in posOrderService — r39/P0: money
// fields join the fingerprint as their EXACT 8dp decimal string forms, so a
// key can never be replayed against a value that differs beyond float64
// precision.
function fingerprint(intent) {
    const canonical = {
        businessProfileId: String(intent.businessProfileId),
        actorId: Number(intent.actorId),
        items: [...intent.items]
            .map(({ productId, quantity }) => ({ productId: String(productId), quantity: Number(quantity) }))
            .sort((a, b) => a.productId.localeCompare(b.productId) || a.quantity - b.quantity),
        paymentMethod: String(intent.paymentMethod || 'CASH').toUpperCase(),
        cash: new Prisma.Decimal(intent.cashGiven || 0).toFixed(8),
        requestedAzm: new Prisma.Decimal(intent.azmAmount || 0).toFixed(8),
        source: intent.source ?? null,
        locationId: intent.locationId ?? null,
        tableId: intent.tableId ?? null,
        customerId: intent.customerId ?? null,
        tipAmount: new Prisma.Decimal(intent.tipAmount || 0).toFixed(8), // r32/I: tips join the fingerprint
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const baseTx = () => ({
    businessOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
    },
    businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'ledger-1' }) },
    businessTaxPreset: { findFirst: jest.fn().mockResolvedValue(null) },
    businessProduct: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null }), updateMany: jest.fn() },
    businessOrderItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    recipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryItem: { updateMany: jest.fn() },
    user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue({ id: 7, azmBalance: 10 }) },
    azmSpendLog: { create: jest.fn() },
    businessLocation: { findFirst: jest.fn() },
    businessTable: { findFirst: jest.fn() },
});

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

    test('a NEW intent is refused after the fingerprint is computed, before any transaction', async () => {
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(),
        };
        const service = new PosOrderService(prisma);

        await expect(service.createOrder({
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 25, idempotencyKey: 'new-key',
        })).rejects.toMatchObject({ code: 'POS_SETTLEMENT_NOT_ENABLED' });

        // The key was examined twice — the replay lookup, then the race re-check
        // that lets an order committed by a concurrent writer still replay
        // instead of being reported as unavailable — and no economic work
        // followed either time.
        expect(prisma.businessOrder.findFirst).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('the fingerprint still binds a committed order: a different tip is refused', async () => {
        const intent = {
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 2 }],
            paymentMethod: 'CASH', cashGiven: 50, idempotencyKey: 'same-key', tipAmount: 2,
        };
        const existing = { id: 'order-1', businessProfileId: 'biz-1', amountUsdc: 41, cashChange: 7 };
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(existing) },
            businessLedgerEntry: { findFirst: jest.fn().mockResolvedValue({ metadata: { posIdempotencyFingerprint: fingerprint(intent) } }) },
            $transaction: jest.fn(),
        };

        // Same key, different tip: the stored fingerprint no longer matches.
        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 2 }],
            paymentMethod: 'CASH', cashGiven: 50, idempotencyKey: 'same-key', tipAmount: 3,
        })).rejects.toThrow('Idempotency key already used for a different POS request.');
    });
});
