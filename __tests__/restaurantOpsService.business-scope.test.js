const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');

describe('RestaurantOpsService business scoping', () => {
    const bpA = 'business-a';

    test('rejects KDS order status updates outside the business', async () => {
        const prisma = { kitchenOrder: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() } };
        const svc = new RestaurantOpsService(prisma);
        await expect(svc.updateOrderStatus('order-b', 'READY', bpA)).rejects.toThrow('Kitchen order not found.');
        expect(prisma.kitchenOrder.findFirst).toHaveBeenCalledWith({ where: { id: 'order-b', businessProfileId: bpA } });
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('rejects KDS item status updates outside the business', async () => {
        const prisma = { kitchenOrder: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() } };
        const svc = new RestaurantOpsService(prisma);
        await expect(svc.updateItemStatus('order-b', 0, 'READY', bpA)).rejects.toThrow('Order not found.');
        expect(prisma.kitchenOrder.findFirst).toHaveBeenCalledWith({
            where: { id: 'order-b', businessProfileId: bpA },
            include: { orderItems: true },
        });
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('rejects chef assignment when the employee belongs to another business', async () => {
        const prisma = { businessEmployee: { findFirst: jest.fn().mockResolvedValue(null) }, kitchenOrder: { findFirst: jest.fn(), update: jest.fn() } };
        const svc = new RestaurantOpsService(prisma);
        await expect(svc.assignChef('order-b', 'employee-b', bpA)).rejects.toThrow('Employee not found.');
        expect(prisma.kitchenOrder.findFirst).not.toHaveBeenCalled();
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('rejects chef assignment when the order belongs to another business', async () => {
        const prisma = {
            businessEmployee: { findFirst: jest.fn().mockResolvedValue({ id: 'employee-a', businessProfileId: bpA, role: 'CHEF', userId: 1 }) },
            kitchenOrder: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
        };
        const svc = new RestaurantOpsService(prisma);
        await expect(svc.assignChef('order-b', 'employee-a', bpA)).rejects.toThrow('Kitchen order not found.');
        expect(prisma.kitchenOrder.update).not.toHaveBeenCalled();
    });

    test('allows same-business chef assignment', async () => {
        const employee = { id: 'employee-a', businessProfileId: bpA, role: 'MANAGER', userId: 1 };
        const updated = { id: 'order-a', businessProfileId: bpA, employeeId: 'employee-a', status: 'PREPARING' };
        const prisma = {
            businessEmployee: { findFirst: jest.fn().mockResolvedValue(employee) },
            kitchenOrder: {
                findFirst: jest.fn().mockResolvedValue({ id: 'order-a' }),
                update: jest.fn().mockResolvedValue(updated),
            },
        };
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.assignChef('order-a', 'employee-a', bpA)).resolves.toEqual(updated);
        expect(prisma.kitchenOrder.update).toHaveBeenCalledWith({
            where: { id: 'order-a' },
            data: expect.objectContaining({ employeeId: 'employee-a', status: 'PREPARING' }),
        });
    });
});
