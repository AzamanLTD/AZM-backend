// BusinessOrder concurrency guards.
// These tests use a minimal Prisma-shaped double so they run without a database.

describe('BusinessOrder — concurrency guards', () => {
    let service;

    beforeEach(() => {
        jest.resetModules();
        service = require('../services/businessOrderService');
    });

    test('markDelivered uses a conditional PAID -> DELIVERED write', async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const findUnique = jest.fn().mockResolvedValue({
            id: 'order-1',
            status: 'DELIVERED',
            deliveredAt: new Date(),
        });
        const prisma = { businessOrder: { updateMany, findUnique } };

        const result = await service.markDelivered(prisma, {
            orderId: 'order-1',
            businessProfileId: 'biz-1',
            deliveryNotes: 'Delivered safely',
        });

        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'order-1', businessProfileId: 'biz-1', status: 'PAID' },
        }));
        expect(result.status).toBe('DELIVERED');
    });

    test('markDelivered does not overwrite a concurrent state transition', async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 0 });
        const findUnique = jest.fn().mockResolvedValue({
            businessProfileId: 'biz-1',
            status: 'COMPLETED',
        });
        const prisma = { businessOrder: { updateMany, findUnique } };

        await expect(service.markDelivered(prisma, {
            orderId: 'order-1',
            businessProfileId: 'biz-1',
        })).rejects.toThrow(/must be in PAID status/i);

        expect(updateMany).toHaveBeenCalledTimes(1);
    });

    test('escrow propagation ignores an impossible source state instead of regressing the order', async () => {
        const findFirst = jest.fn().mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
        const updateMany = jest.fn();
        const findUnique = jest.fn();
        const prisma = { businessOrder: { findFirst, updateMany, findUnique } };

        const result = await service.updateOrderStatusFromEscrow(prisma, 'escrow-1', 'FUNDED');

        expect(result).toEqual({ id: 'order-1', status: 'COMPLETED' });
        expect(updateMany).not.toHaveBeenCalled();
    });
});
