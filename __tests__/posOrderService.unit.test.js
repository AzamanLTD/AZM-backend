// =============================================================================
// WP-POS-C0 — these suites were written when a POS sale could still be created.
// It cannot: `PosOrderService.createOrder` now refuses every NEW order because
// there is no truthful order-currency contract (see POS_SETTLEMENT_CONTRACT).
//
// The coverage is NOT deleted. It is re-pointed at the settlement methods that
// still exist and still have to be correct on the day a currency contract
// re-opens settlement:
//   • _priceItems      — catalog scoping, exact-decimal line totals
//   • _computeTax      — the business tax authority
//   • _consumeInventory— tracked stock and recipe ingredients
// and the containment gate itself is asserted to run BEFORE any of them.
// =============================================================================
const { Prisma } = require('@prisma/client');
const { PosOrderService, POS_SETTLEMENT_REFUSAL_CODE } = require('../services/businessOS/posOrderService');

const decimal = (v) => new Prisma.Decimal(v);

function baseTx(overrides = {}) {
    return {
        businessProduct: {
            findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        businessTaxPreset: { findFirst: jest.fn().mockResolvedValue(null) },
        recipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
        inventoryItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        businessOrder: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
        businessLedgerEntry: { create: jest.fn() },
        businessOrderItem: { createMany: jest.fn() },
        ...overrides,
    };
}

describe('PosOrderService — containment precedes every economic step', () => {
    test('a new order is refused before the transaction, pricing, stock or ledger', async () => {
        const tx = baseTx();
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            businessProduct: { findFirst: jest.fn() },
            businessLedgerEntry: { create: jest.fn() },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };

        await expect(new PosOrderService(prisma).createOrder({
            businessProfileId: 'biz-1', actorId: 7,
            items: [{ productId: 'prod-1', quantity: 2 }],
            paymentMethod: 'CASH', cashGiven: 100, idempotencyKey: 'c0-1',
        })).rejects.toMatchObject({ code: POS_SETTLEMENT_REFUSAL_CODE, statusCode: 422 });

        // Nothing economic was touched, and no transaction was even opened.
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.businessProduct.findFirst).not.toHaveBeenCalled();
        expect(tx.businessProduct.updateMany).not.toHaveBeenCalled();
        expect(tx.businessOrder.create).not.toHaveBeenCalled();
        expect(tx.businessLedgerEntry.create).not.toHaveBeenCalled();
        expect(tx.recipeIngredient.findMany).not.toHaveBeenCalled();
        expect(tx.inventoryItem.updateMany).not.toHaveBeenCalled();
    });
});

describe('PosOrderService settlement internals (retained for a future currency contract)', () => {
    test('_priceItems re-derives exact-decimal line totals from transaction-time catalog state', async () => {
        const tx = baseTx();
        const priced = await new PosOrderService({})._priceItems(tx, 'biz-1', [{ productId: 'prod-1', quantity: 3 }], undefined);

        expect(String(priced.subtotal)).toBe('60');
        expect(priced.subtotal instanceof Prisma.Decimal).toBe(true);
        expect(tx.businessProduct.findFirst).toHaveBeenCalledWith({
            where: { id: 'prod-1', businessProfileId: 'biz-1', isActive: true, isAvailable: true, locationId: null },
            select: { id: true, name: true, priceUsdc: true, stockQty: true },
        });
    });

    test('_priceItems keeps prices whose decimal form is exact and rejects sub-pesewa noise', async () => {
        const tx = baseTx({
            businessProduct: {
                findFirst: jest.fn()
                    .mockResolvedValueOnce({ id: 'prod-1', name: 'Meal', priceUsdc: '0.1', stockQty: null })
                    .mockResolvedValueOnce({ id: 'prod-2', name: 'Noise', priceUsdc: '0.000000001', stockQty: null }),
                updateMany: jest.fn(),
            },
        });
        const service = new PosOrderService({});

        // 0.1 must stay exactly 0.1 — never 0.10000000000000001.
        const exact = await service._priceItems(tx, 'biz-1', [{ productId: 'prod-1', quantity: 3 }], undefined);
        expect(String(exact.subtotal)).toBe('0.3');

        // 9 decimal places is beyond the 8dp money contract.
        await expect(service._priceItems(tx, 'biz-1', [{ productId: 'prod-2', quantity: 1 }], undefined))
            .rejects.toThrow('Invalid catalog price for product: Noise');
    });

    test('_computeTax uses the business default preset through the exact tax authority', async () => {
        const tx = baseTx({
            businessTaxPreset: { findFirst: jest.fn().mockResolvedValue({ name: 'VAT', type: 'PERCENTAGE', value: 2.5 }) },
        });
        const result = await new PosOrderService({})._computeTax(tx, 'biz-1', decimal('40'));
        expect(String(result.taxTotal)).toBe('1');
        expect(tx.businessTaxPreset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { businessProfileId: 'biz-1', isDefault: true },
        }));
    });

    test('_computeTax supports a FLAT preset and rejects an unsupported type', async () => {
        const flat = baseTx({
            businessTaxPreset: { findFirst: jest.fn().mockResolvedValue({ name: 'Service', type: 'FLAT', value: 5 }) },
        });
        const flatResult = await new PosOrderService({})._computeTax(flat, 'biz-1', decimal('40'));
        expect(String(flatResult.taxTotal)).toBe('5');

        const weird = baseTx({
            businessTaxPreset: { findFirst: jest.fn().mockResolvedValue({ name: 'Unknown', type: 'WEIRD', value: 10 }) },
        });
        await expect(new PosOrderService({})._computeTax(weird, 'biz-1', decimal('40')))
            .rejects.toThrow("Unsupported tax line type for 'Unknown'");
    });

    test('_computeTax falls back to no tax when no preset is configured', async () => {
        const tx = baseTx();
        const result = await new PosOrderService({})._computeTax(tx, 'biz-1', decimal('40'));
        expect(String(result.taxTotal)).toBe('0');
    });

    test('_consumeInventory decrements tracked stock with a guarded update', async () => {
        const tx = baseTx();
        await new PosOrderService({})._consumeInventory(tx, 'biz-1', [
            { productId: 'prod-1', quantity: 2, name: 'Meal', trackedStockQty: 10 },
        ]);
        expect(tx.businessProduct.updateMany).toHaveBeenCalledWith({
            where: { id: 'prod-1', businessProfileId: 'biz-1', isActive: true, isAvailable: true, stockQty: { gte: 2 } },
            data: { stockQty: { decrement: 2 } },
        });
    });

    test('_consumeInventory refuses a sale whose tracked stock cannot cover it', async () => {
        const tx = baseTx({ businessProduct: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) } });
        await expect(new PosOrderService({})._consumeInventory(tx, 'biz-1', [
            { productId: 'prod-1', quantity: 99, name: 'Meal', trackedStockQty: 1 },
        ])).rejects.toThrow('Insufficient stock for product: Meal');
        // The order must not be created after a failed deduction.
        expect(tx.businessOrder.create).not.toHaveBeenCalled();
    });

    test('_consumeInventory aggregates duplicate lines before deducting ingredients', async () => {
        const tx = baseTx({
            businessProduct: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            recipeIngredient: {
                findMany: jest.fn().mockResolvedValue([
                    { productId: 'prod-1', inventoryItemId: 'inv-1', quantityRequired: 0.1 },
                ]),
            },
            inventoryItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        });
        await new PosOrderService({})._consumeInventory(tx, 'biz-1', [
            { productId: 'prod-1', quantity: 2, name: 'Meal', trackedStockQty: null },
            { productId: 'prod-1', quantity: 3, name: 'Meal', trackedStockQty: null },
        ]);
        // 0.1 * 5 = 0.5 exactly — duplicate lines are summed, not double-counted
        // and not float-multiplied.
        expect(tx.inventoryItem.updateMany).toHaveBeenCalledWith({
            where: { id: 'inv-1', businessProfileId: 'biz-1', isActive: true, currentStock: { gte: 0.5 } },
            data: { currentStock: { decrement: 0.5 } },
        });
    });
});
