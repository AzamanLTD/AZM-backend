const { withOrderTrackingMutation } = require('../services/orderTrackingMutationSafeService');

describe('order tracking mutation safety', () => {
    test('locks per order inside one transaction before loading the tracking row', async () => {
        const orderTracking = {
            upsert: jest.fn().mockResolvedValue({ orderId: 'order-1', timeline: [] }),
        };
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            orderTracking,
        };
        const prisma = {
            $transaction: jest.fn(async (callback) => callback(tx)),
        };

        const mutate = jest.fn().mockResolvedValue('done');
        const result = await withOrderTrackingMutation(prisma, 'order-1', 'biz-1', mutate);

        expect(result).toBe('done');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        expect(tx.orderTracking.upsert).toHaveBeenCalledWith({
            where: { orderId: 'order-1' },
            create: { orderId: 'order-1', businessProfileId: 'biz-1' },
            update: {},
        });
        expect(mutate).toHaveBeenCalledWith(tx, { orderId: 'order-1', timeline: [] });
    });
});
