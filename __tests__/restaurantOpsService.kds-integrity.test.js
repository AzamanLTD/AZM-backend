const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');

describe('RestaurantOpsService KDS item integrity', () => {
    test('rejects negative and non-integer item indexes before mutation', async () => {
        const prisma = { kitchenOrder: { findFirst: jest.fn(), update: jest.fn() } };
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.updateItemStatus('order-a', -1, 'READY', 'business-a')).rejects.toThrow('Invalid kitchen item index.');
        await expect(svc.updateItemStatus('order-a', 1.5, 'READY', 'business-a')).rejects.toThrow('Invalid kitchen item index.');
        expect(prisma.kitchenOrder.findFirst).not.toHaveBeenCalled();
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('scopes the KDS order to the business and rejects a missing item', async () => {
        const prisma = {
            kitchenOrder: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new RestaurantOpsService(prisma);
        await expect(svc.updateItemStatus('order-other', 0, 'READY', 'business-a')).rejects.toThrow('Order not found.');
        expect(prisma.kitchenOrder.findFirst).toHaveBeenCalledWith({
            where: { id: 'order-other', businessProfileId: 'business-a' },
            include: { orderItems: true },
        });
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('rejects an out-of-range index instead of treating an empty array as all-served', async () => {
        const prisma = {
            kitchenOrder: {
                findFirst: jest.fn().mockResolvedValue({ id: 'order-a', businessProfileId: 'business-a', orderItems: [] }),
                update: jest.fn(),
            },
        };
        const svc = new RestaurantOpsService(prisma);
        await expect(svc.updateItemStatus('order-a', 0, 'SERVED', 'business-a')).rejects.toThrow('Kitchen item not found.');
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('updates the selected item and promotes the order only when every item is ready', async () => {
        const prisma = {
            kitchenOrder: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'order-a',
                    businessProfileId: 'business-a',
                    orderItems: [{ id: 'item-a', status: 'NEW' }, { id: 'item-b', status: 'READY' }],
                }),
                update: jest.fn().mockResolvedValue({ id: 'order-a', status: 'READY' }),
            },
        };
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.updateItemStatus('order-a', 0, 'READY', 'business-a')).resolves.toMatchObject({ status: 'READY' });
        expect(prisma.kitchenOrder.update).toHaveBeenCalledWith({
            where: { id: 'order-a' },
            data: {
                orderItems: [
                    { id: 'item-a', status: 'READY' },
                    { id: 'item-b', status: 'READY' },
                ],
                status: 'READY',
                readyAt: expect.any(Date),
            },
        });
    });
});
