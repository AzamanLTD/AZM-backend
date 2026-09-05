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

    test('uses the transaction business tax authority while re-deriving catalog prices and committing atomically', async () => {
        const tx = baseTx({
            businessTaxPreset: {
                findFirst: jest.fn().mockResolvedValue({ name: 'POS Tax', type: 'PERCENTAGE', value: 2.5 }),
            },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn(() => { throw new Error('catalog must be read through transaction client'); }) },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        const result = await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 2 }], paymentMethod: 'AZM', idempotencyKey: 'pos-1',
        });

        expect(result.computedGrand).toBe(41);
        expect(tx.businessTaxPreset.findFirst).toHaveBeenCalledWith({
            where: { businessProfileId: 'biz-1', isDefault: true },
            orderBy: { createdAt: 'asc' },
            select: { name: true, type: true, value: true },
        });
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
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                amount: 41,
                metadata: expect.objectContaining({
                    subtotal: 40,
                    tax: 1,
                    taxLines: [{ name: 'POS Tax', type: 'PERCENTAGE', value: 2.5, computedAmount: 1 }],
                }),
            },
        }));
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

    test('uses the business default tax authority and computes cash change server-side', async () => {
        const tx = baseTx({
            businessTaxPreset: {
                findFirst: jest.fn().mockResolvedValue({ name: 'POS Tax', type: 'PERCENTAGE', value: 2.5 }),
            },
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
        expect(tx.businessTaxPreset.findFirst).toHaveBeenCalledWith({
            where: { businessProfileId: 'biz-1', isDefault: true },
            orderBy: { createdAt: 'asc' },
            select: { name: true, type: true, value: true },
        });
        expect(tx.businessOrder.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ paymentMethod: 'CASH', cashReceived: 25, cashChange: 4.5 }),
        }));
    });

    test('decrements tracked retail stock in the same transaction as the sale', async () => {
        const tx = baseTx({
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Bottle', priceUsdc: 5, stockQty: 10, isActive: true, isAvailable: true }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 3 }], paymentMethod: 'CASH', cashGiven: 20, idempotencyKey: 'stock-1',
        });

        expect(tx.businessProduct.updateMany).toHaveBeenCalledWith({
            where: { id: 'prod-1', businessProfileId: 'biz-1', isActive: true, isAvailable: true, stockQty: { gte: 3 } },
            data: { stockQty: { decrement: 3 } },
        });
    });

    test('decrements recipe ingredients atomically for restaurant products', async () => {
        const tx = baseTx({
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Jollof', priceUsdc: 10, stockQty: null, isActive: true, isAvailable: true }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recipeIngredient: {
                findMany: jest.fn().mockResolvedValue([
                    { productId: 'prod-1', inventoryItemId: 'inv-rice', quantityRequired: 0.25 },
                    { productId: 'prod-1', inventoryItemId: 'inv-oil', quantityRequired: 0.1 },
                ]),
            },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 2 }], paymentMethod: 'CASH', cashGiven: 25, idempotencyKey: 'recipe-1',
        });

        expect(tx.inventoryItem.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: 'inv-rice', businessProfileId: 'biz-1', isActive: true, currentStock: { gte: 0.5 } },
            data: { currentStock: { decrement: 0.5 } },
        });
        expect(tx.inventoryItem.updateMany).toHaveBeenNthCalledWith(2, {
            where: { id: 'inv-oil', businessProfileId: 'biz-1', isActive: true, currentStock: { gte: 0.2 } },
            data: { currentStock: { decrement: 0.2 } },
        });
    });

    test('aggregates duplicate order lines before recipe ingredient consumption', async () => {
        const tx = baseTx({
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Jollof', priceUsdc: 10, stockQty: null, isActive: true, isAvailable: true }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recipeIngredient: {
                findMany: jest.fn().mockResolvedValue([
                    { productId: 'prod-1', inventoryItemId: 'inv-rice', quantityRequired: 0.25 },
                ]),
            },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1',
            actorId: 7,
            items: [
                { productId: 'prod-1', quantity: 2 },
                { productId: 'prod-1', quantity: 3 },
            ],
            paymentMethod: 'CASH',
            cashGiven: 55,
            idempotencyKey: 'recipe-duplicate-1',
        });

        expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith({
            where: { id: 'inv-rice', businessProfileId: 'biz-1', isActive: true, currentStock: { gte: 1.25 } },
            data: { currentStock: { decrement: 1.25 } },
        });
    });

    test('refuses a sale when tracked product stock is insufficient before order creation', async () => {
        const tx = baseTx({
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Bottle', priceUsdc: 5, stockQty: 1, isActive: true, isAvailable: true }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
        });
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 2 }], paymentMethod: 'CASH', cashGiven: 20, idempotencyKey: 'stock-fail-1',
        })).rejects.toThrow('Insufficient stock for product: Bottle');
        expect(tx.businessOrder.create).not.toHaveBeenCalled();
        expect(tx.businessLedgerEntry.create).not.toHaveBeenCalled();
    });

    test('replays idempotently before catalog validation when the product is no longer available', async () => {
        const existing = { id: 'order-1', businessProfileId: 'biz-1', amountUsdc: 41, cashChange: 0 };
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue(existing) },
            $transaction: jest.fn(),
        };

        const result = await new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'removed-product', quantity: 1 }], paymentMethod: 'AZM', idempotencyKey: 'pos-1',
        });

        expect(result.duplicate).toBe(true);
        expect(result.computedGrand).toBe(41);
        expect(prisma.businessProduct.findFirst).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('rejects an idempotency key owned by another business', async () => {
        const prisma = {
            businessProduct: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-other', businessProfileId: 'biz-2' }) },
            $transaction: jest.fn(),
        };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7, items: [{ productId: 'prod-1', quantity: 1 }], paymentMethod: 'CASH', cashGiven: 21, idempotencyKey: 'same-key',
        })).rejects.toThrow('Idempotency key already belongs to another business.');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
