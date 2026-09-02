'use strict';

const businessProductService = require('../services/businessProductService');

function prismaMock() {
    return {
        businessProfile: { findUnique: jest.fn() },
        businessProduct: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        catalogSection: { findUnique: jest.fn() },
        businessLocation: { findUnique: jest.fn() },
        businessOrder: { count: jest.fn() },
    };
}

describe('business product option contract', () => {
    test('create persists variants, modifier groups and customer-facing product metadata', async () => {
        const prisma = prismaMock();
        prisma.businessProfile.findUnique.mockResolvedValue({ id: 'bp-1', businessName: 'Test Restaurant' });
        prisma.businessProduct.findUnique.mockResolvedValue(null);
        prisma.catalogSection.findUnique.mockResolvedValue({ id: 'section-1', businessProfileId: 'bp-1' });
        prisma.businessLocation.findUnique.mockResolvedValue({ id: 'location-1', businessProfileId: 'bp-1' });
        prisma.businessProduct.create.mockResolvedValue({ id: 'product-1' });

        const variants = [{ name: 'Large', priceDelta: 3 }];
        const modifierGroups = [{
            name: 'Sauce',
            maxSelection: 1,
            options: [{ name: 'Pepper', priceDelta: 1.5 }],
        }];

        await businessProductService.createProduct(prisma, {
            businessProfileId: 'bp-1',
            name: 'Jollof Rice',
            priceUsdc: 12,
            category: 'FOOD_BEVERAGE',
            catalogSectionId: 'section-1',
            locationId: 'location-1',
            tags: ['POPULAR'],
            calorieCount: 640,
            preparationMins: 18,
            variants,
            modifierGroups,
            deliveryTerms: 'Pickup or delivery',
            estimatedDelivery: '25–35 min',
            isAvailable: true,
        });

        expect(prisma.businessProduct.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                catalogSectionId: 'section-1',
                locationId: 'location-1',
                tags: ['POPULAR'],
                calorieCount: 640,
                preparationMins: 18,
                variants,
                modifierGroups,
                deliveryTerms: 'Pickup or delivery',
                estimatedDelivery: '25–35 min',
                isAvailable: true,
            }),
        });
    });

    test('update accepts option data instead of silently dropping it', async () => {
        const prisma = prismaMock();
        prisma.businessProduct.findUnique.mockResolvedValue({
            id: 'product-1',
            businessProfileId: 'bp-1',
            name: 'Jollof Rice',
            businessProfile: { businessName: 'Test Restaurant' },
        });
        prisma.businessProduct.update.mockResolvedValue({ id: 'product-1' });

        const variants = [{ name: 'Family', priceDelta: 8 }];
        const modifierGroups = [{
            name: 'Protein',
            maxSelection: 1,
            options: [{ name: 'Chicken', priceDelta: 4 }],
        }];

        await businessProductService.updateProduct(prisma, {
            productId: 'product-1',
            businessProfileId: 'bp-1',
            updates: {
                variants,
                modifierGroups,
                preparationMins: 25,
                isAvailable: false,
            },
        });

        expect(prisma.businessProduct.update).toHaveBeenCalledWith({
            where: { id: 'product-1' },
            data: expect.objectContaining({
                variants,
                modifierGroups,
                preparationMins: 25,
                isAvailable: false,
            }),
        });
    });

    test('rejects malformed options before writing', async () => {
        const prisma = prismaMock();
        prisma.businessProduct.findUnique.mockResolvedValue({
            id: 'product-1',
            businessProfileId: 'bp-1',
            name: 'Jollof Rice',
            businessProfile: { businessName: 'Test Restaurant' },
        });

        await expect(businessProductService.updateProduct(prisma, {
            productId: 'product-1',
            businessProfileId: 'bp-1',
            updates: {
                modifierGroups: [{ name: 'Sauce', maxSelection: 0, options: [] }],
            },
        })).rejects.toThrow('maxSelection must be an integer from 1 to 20');

        expect(prisma.businessProduct.update).not.toHaveBeenCalled();
    });
});
