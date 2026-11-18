// =============================================================================
// WP-POS-C0 — location/table/product boundaries are enforced INSIDE the
// settlement transaction, which no NEW order can reach while the containment
// contract is closed (PosOrderService.createOrder refuses first). The boundary
// methods are therefore driven directly, so their assertions stay alive for the
// day a truthful order-currency contract re-opens settlement. The containment
// suite proves createOrder refuses before any of them run.
// =============================================================================
const { PosOrderService } = require('../services/businessOS/posOrderService');

describe('PosOrderService location/table/product boundaries', () => {
    function tx(overrides = {}) {
        return {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
            businessLocation: { findFirst: jest.fn().mockResolvedValue({ id: 'loc-1' }) },
            businessTable: { findFirst: jest.fn().mockResolvedValue({ id: 'table-1' }) },
            businessProduct: {
                findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Meal', priceUsdc: 20, stockQty: null }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            recipeIngredient: { findMany: jest.fn().mockResolvedValue([]) },
            inventoryItem: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            ...overrides,
        };
    }

    test('rejects tableId without locationId', async () => {
        const transaction = tx();
        await expect(new PosOrderService({})._validateOrderContext(transaction, 'biz-1', undefined, 'table-1'))
            .rejects.toThrow('tableId requires locationId.');
        expect(transaction.businessLocation.findFirst).not.toHaveBeenCalled();
        expect(transaction.businessOrder.create).not.toHaveBeenCalled();
    });

    test('requires the requested location to belong to the current business and be active', async () => {
        const transaction = tx({ businessLocation: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(new PosOrderService({})._validateOrderContext(transaction, 'biz-1', 'loc-2', undefined))
            .rejects.toThrow('Invalid or inactive business location.');
        expect(transaction.businessLocation.findFirst).toHaveBeenCalledWith({
            where: { id: 'loc-2', businessProfileId: 'biz-1', isActive: true },
            select: { id: true },
        });
        expect(transaction.businessTable.findFirst).not.toHaveBeenCalled();
    });

    test('requires the table to belong to the exact requested location', async () => {
        const transaction = tx({ businessTable: { findFirst: jest.fn().mockResolvedValue(null) } });
        await expect(new PosOrderService({})._validateOrderContext(transaction, 'biz-1', 'loc-1', 'table-2'))
            .rejects.toThrow('Invalid or inactive business table for location.');
        expect(transaction.businessTable.findFirst).toHaveBeenCalledWith({
            where: { id: 'table-2', locationId: 'loc-1', isActive: true },
            select: { id: true },
        });
        expect(transaction.businessOrder.create).not.toHaveBeenCalled();
    });

    test('only accepts globally available or exact-branch products when a location is supplied', async () => {
        const transaction = tx();
        await new PosOrderService({})._priceItems(transaction, 'biz-1', [{ productId: 'prod-1', quantity: 1 }], 'loc-1');
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

    test('customerId shape is validated before any economic step runs', async () => {
        const transaction = tx();
        const prisma = { businessOrder: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn(async (fn) => fn(transaction)) };
        const service = new PosOrderService(prisma);

        // A malformed id is a request problem (400), decided before the refusal.
        await expect(service.createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 25, customerId: '4.5', idempotencyKey: 'ctx-5',
        })).rejects.toThrow('Invalid customerId.');

        // A valid numeric id proceeds to the containment refusal, so "preserved
        // for cash orders" is not a claim this deployment can make any more.
        await expect(service.createOrder({
            businessProfileId: 'biz-1', actorId: 1, items: [{ productId: 'prod-1', quantity: 1 }],
            paymentMethod: 'CASH', cashGiven: 25, customerId: '42', idempotencyKey: 'ctx-6',
        })).rejects.toMatchObject({ code: 'POS_SETTLEMENT_NOT_ENABLED' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(transaction.businessOrder.create).not.toHaveBeenCalled();
    });
});
