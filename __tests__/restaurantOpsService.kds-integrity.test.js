const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');

// r32/D contract: KDS item mutation takes a string item id (not a numeric
// index), scopes both the order and the item to the calling business, and
// re-derives the parent order status from ALL item rows inside a
// serializable transaction. The old index-based API let an out-of-range or
// fractional index reach the database and treated an empty item array as
// "all served"; these unit proofs pin the replacement semantics.

const txFor = (items, order) => ({
    kitchenOrderItem: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue(items),
    },
    kitchenOrder: {
        findUnique: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue(order),
    },
});

describe('RestaurantOpsService KDS item integrity', () => {
    test('rejects a missing or non-string item id before touching the database', async () => {
        const prisma = {
            kitchenOrder: { findFirst: jest.fn() },
            kitchenOrderItem: { findFirst: jest.fn() },
        };
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.updateItemStatus('order-a', '', 'READY', 'business-a')).rejects.toThrow('A kitchen item id is required.');
        await expect(svc.updateItemStatus('order-a', 0, 'READY', 'business-a')).rejects.toThrow('A kitchen item id is required.');
        expect(prisma.kitchenOrder.findFirst).not.toHaveBeenCalled();
        expect(prisma.kitchenOrderItem.findFirst).not.toHaveBeenCalled();
    });

    test('scopes the KDS order to the business before anything else', async () => {
        const prisma = {
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue(null) },
            kitchenOrderItem: { findFirst: jest.fn() },
        };
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.updateItemStatus('order-other', 'item-a', 'READY', 'business-a')).rejects.toThrow('Order not found.');
        expect(prisma.kitchenOrder.findFirst).toHaveBeenCalledWith({
            where: { id: 'order-other', businessProfileId: 'business-a' },
            select: { id: true, status: true },
        });
        expect(prisma.kitchenOrderItem.findFirst).not.toHaveBeenCalled();
    });

    test('rejects an item id that does not belong to that order', async () => {
        const prisma = {
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', status: 'NEW' }) },
            kitchenOrderItem: { findFirst: jest.fn().mockResolvedValue(null) },
        };
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.updateItemStatus('order-a', 'item-foreign', 'READY', 'business-a')).rejects.toThrow('Kitchen item not found.');
        expect(prisma.kitchenOrderItem.findFirst).toHaveBeenCalledWith({
            where: { id: 'item-foreign', kitchenOrderId: 'order-a' },
            select: { id: true, status: true },
        });
        expect(prisma.$transaction).toBeUndefined();
    });

    test('rejects an out-of-flow item status transition', async () => {
        const prisma = {
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', status: 'NEW' }) },
            kitchenOrderItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-a', status: 'NEW' }) },
            $transaction: jest.fn(),
        };
        const svc = new RestaurantOpsService(prisma);

        // NEW → SERVED skips PREPARING and READY.
        await expect(svc.updateItemStatus('order-a', 'item-a', 'SERVED', 'business-a'))
            .rejects.toThrow('Invalid item status transition');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('updates the selected item and promotes the order only when every item is ready', async () => {
        const tx = txFor(
            [{ status: 'READY' }, { status: 'READY' }],
            { id: 'order-a', status: 'READY', items: [] },
        );
        // First findUnique = parent status BEFORE promotion (PREPARING);
        // second = the returned post-update order (READY).
        tx.kitchenOrder.findUnique
            .mockResolvedValueOnce({ id: 'order-a', status: 'PREPARING' })
            .mockResolvedValue({ id: 'order-a', status: 'READY', items: [] });
        const prisma = {
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', status: 'PREPARING' }) },
            kitchenOrderItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-a', status: 'PREPARING' }) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };
        const svc = new RestaurantOpsService(prisma);

        // Single-step PREPARING → READY is the valid transition.
        const result = await svc.updateItemStatus('order-a', 'item-a', 'READY', 'business-a');

        expect(tx.kitchenOrderItem.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'item-a' },
            data: expect.objectContaining({ status: 'READY' }),
        }));
        expect(tx.kitchenOrder.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'order-a' },
            data: { status: 'READY', readyAt: expect.any(Date) },
        }));
        expect(result).toMatchObject({ id: 'order-a', status: 'READY' });
    });

    test('never promotes an order whose item set is empty (no "all served" on zero items)', async () => {
        const tx = txFor([], { id: 'order-a', status: 'NEW', items: [] });
        const prisma = {
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', status: 'NEW' }) },
            kitchenOrderItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-a', status: 'PREPARING' }) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };
        const svc = new RestaurantOpsService(prisma);

        const result = await svc.updateItemStatus('order-a', 'item-a', 'READY', 'business-a');

        expect(tx.kitchenOrder.update).not.toHaveBeenCalled();
        expect(result).toMatchObject({ id: 'order-a', status: 'NEW' });
    });

    test('does not move the parent order backwards (SERVED stays SERVED)', async () => {
        // Parent already SERVED; a late item touch must not demote it.
        const tx = txFor(
            [{ status: 'SERVED' }, { status: 'READY' }],
            { id: 'order-a', status: 'SERVED', items: [] },
        );
        const prisma = {
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue({ id: 'order-a', status: 'SERVED' }) },
            kitchenOrderItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-b', status: 'READY' }) },
            $transaction: jest.fn(async (fn) => fn(tx)),
        };
        const svc = new RestaurantOpsService(prisma);

        const result = await svc.updateItemStatus('order-a', 'item-b', 'SERVED', 'business-a');

        // Derived status would be READY (item-a SERVED, item-b SERVED → actually all
        // SERVED → SERVED, equal to parent) — either way never below SERVED.
        expect(tx.kitchenOrder.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'READY' }) }),
        );
        expect(result).toMatchObject({ id: 'order-a' });
    });
});
