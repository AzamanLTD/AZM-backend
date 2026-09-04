'use strict';

const businessProductService = require('../services/businessProductService');

describe('business product location filtering', () => {
  test('selected location includes global and exact-location products only', async () => {
    const rows = [{ id: 'p1' }, { id: 'p2' }];
    const prisma = {
      businessProduct: { findMany: jest.fn().mockResolvedValue(rows) },
    };

    const result = await businessProductService.listProducts(prisma, {
      businessProfileId: 'biz-1',
      isActive: true,
      locationId: 'loc-2',
      limit: 20,
    });

    expect(result.products).toEqual(rows);
    expect(prisma.businessProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        businessProfileId: 'biz-1',
        isActive: true,
        OR: [{ locationId: null }, { locationId: 'loc-2' }],
      },
    }));
  });

  test('without location the existing all-products listing remains unchanged', async () => {
    const prisma = { businessProduct: { findMany: jest.fn().mockResolvedValue([]) } };
    await businessProductService.listProducts(prisma, { businessProfileId: 'biz-1', isActive: true, limit: 20 });
    expect(prisma.businessProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { businessProfileId: 'biz-1', isActive: true },
    }));
  });
});
