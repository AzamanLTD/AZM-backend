const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');

describe('RestaurantOpsService KDS creation scoping', () => {
    const bpA = 'business-a';
    const bpB = 'business-b';

    function basePrisma() {
        return {
            businessLocation: { findFirst: jest.fn() },
            businessOrder: { findFirst: jest.fn() },
            kitchenOrder: { count: jest.fn(), create: jest.fn() },
            businessProduct: { findFirst: jest.fn() },
        };
    }

    test('rejects a location belonging to another business', async () => {
        const prisma = basePrisma();
        prisma.businessLocation.findFirst.mockResolvedValue(null);
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.createKitchenOrder({
            businessProfileId: bpA,
            locationId: 'location-b',
            items: [{ productId: 'product-a', quantity: 1 }],
        })).rejects.toThrow('Location not found for this business.');
        expect(prisma.businessProduct.findFirst).not.toHaveBeenCalled();
        expect(prisma.kitchenOrder.create).not.toHaveBeenCalled();
    });

    test('rejects a business order belonging to another business', async () => {
        const prisma = basePrisma();
        prisma.businessOrder.findFirst.mockResolvedValue(null);
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.createKitchenOrder({
            businessProfileId: bpA,
            businessOrderId: 'order-b',
            items: [{ productId: 'product-a', quantity: 1 }],
        })).rejects.toThrow('Business order not found for this business.');
        expect(prisma.businessProduct.findFirst).not.toHaveBeenCalled();
    });

    test('rejects a product belonging to another business instead of silently dropping it', async () => {
        const prisma = basePrisma();
        prisma.businessProduct.findFirst.mockResolvedValue(null);
        prisma.kitchenOrder.count.mockResolvedValue(0);
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.createKitchenOrder({
            businessProfileId: bpA,
            items: [{ productId: 'product-b', quantity: 1 }],
        })).rejects.toThrow('Product not found for this business: product-b');
        expect(prisma.businessProduct.findFirst).toHaveBeenCalledWith({
            where: { id: 'product-b', businessProfileId: bpA, isActive: true },
        });
        expect(prisma.kitchenOrder.create).not.toHaveBeenCalled();
    });

    test('allows same-business inputs', async () => {
        const prisma = basePrisma();
        prisma.businessLocation.findFirst.mockResolvedValue({ id: 'location-a' });
        prisma.businessOrder.findFirst.mockResolvedValue({ id: 'order-a' });
        prisma.kitchenOrder.count.mockResolvedValue(2);
        prisma.businessProduct.findFirst.mockResolvedValue({
            id: 'product-a', name: 'Jollof', businessProfileId: bpA, isActive: true,
            metadata: { station: 'HOT', allergens: ['GLUTEN'] },
        });
        prisma.kitchenOrder.create.mockResolvedValue({ id: 'ticket-a' });
        const svc = new RestaurantOpsService(prisma);

        await expect(svc.createKitchenOrder({
            businessProfileId: bpA,
            locationId: 'location-a',
            businessOrderId: 'order-a',
            items: [{ productId: 'product-a', quantity: 1 }],
        })).resolves.toEqual({ id: 'ticket-a' });
        expect(prisma.kitchenOrder.create).toHaveBeenCalled();
    });
});
