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

    test('persists the request fingerprint and authoritative tax in the atomic POS ledger entry', async () => {
        const tx = baseTx();
        tx.businessOrder.create.mockResolvedValue({ id: 'order-1', businessProfileId: 'biz-1', amountUsdc: 20.5, cashChange: 4.5 });
        tx.businessTaxPreset.findFirst.mockResolvedValue({ name: 'VAT', type: 'PERCENTAGE', value: 2.5 });
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

        // r39/P1 exact-money contract: Decimals round-trip as exact
        // strings — never float mirrors.
        const ledgerArgs = tx.businessLedgerEntry.create.mock.calls[0][0];
        expect(String(ledgerArgs.data.amount)).toBe('20.5');
        expect(ledgerArgs.data.metadata.tax).toBe('0.50000000');
        expect(ledgerArgs.data.metadata.tipAmount).toBe('0.00000000'); // r32/I: tip is ledgered alongside the fingerprint
        expect(ledgerArgs.data.metadata.taxLines).toEqual([{ name: 'VAT', type: 'PERCENTAGE', value: '2.5', computedAmount: '0.50000000' }]);
        expect(ledgerArgs.data.metadata.posIdempotencyFingerprint).toBe(fingerprint(intent));
    });

    test('uses flat business tax preset instead of a hard-coded percentage', async () => {
        const tx = baseTx();
        tx.businessOrder.create.mockResolvedValue({ id: 'order-2', businessProfileId: 'biz-1', amountUsdc: 25, cashChange: 0 });
        tx.businessTaxPreset.findFirst.mockResolvedValue({ name: 'Service', type: 'FLAT', value: 5 });
        tx.businessProduct.findFirst.mockResolvedValue({ id: 'prod-2', name: 'Meal', priceUsdc: 20, stockQty: null });
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(tx)) };

        const result = await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-2', quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 25,
        });

        expect(result.computedTax).toBe(5);
        expect(result.computedGrand).toBe(25);
        expect(tx.businessTaxPreset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { businessProfileId: 'biz-1', isDefault: true },
        }));
    });

    test('rejects an unsupported business tax preset type instead of silently charging a percentage', async () => {
        const tx = baseTx();
        tx.businessTaxPreset.findFirst.mockResolvedValue({ name: 'Unknown', type: 'WEIRD', value: 10 });
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(tx)) };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-3', quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 25,
        })).rejects.toThrow("Unsupported tax line type for 'Unknown'");
        expect(tx.businessOrder.create).not.toHaveBeenCalled();
    });
});
