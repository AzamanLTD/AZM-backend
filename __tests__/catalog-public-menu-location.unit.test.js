'use strict';

const controller = require('../controllers/catalogSectionController');

describe('public catalog menu location boundary', () => {
  test('location-scoped menu verifies the location and filters sections and products', async () => {
    const prisma = {
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'biz-1', isSuspended: false }),
      },
      businessLocation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'loc-1', label: 'Airport Branch' }),
      },
      catalogSection: {
        findMany: jest.fn().mockResolvedValue([{ id: 'section-1', products: [{ id: 'product-1' }] }]),
      },
      businessProduct: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const req = { app: { get: () => prisma }, params: { bizId: 'BIZ-1' }, query: { locationId: 'loc-1' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.getPublicMenu(req, res);

    expect(prisma.businessLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc-1', businessProfileId: 'biz-1', isActive: true },
      select: { id: true, label: true },
    });
    expect(prisma.catalogSection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessProfileId: 'biz-1',
        isActive: true,
        OR: [{ locationId: null }, { locationId: 'loc-1' }],
      }),
      include: {
        products: {
          where: {
            isActive: true,
            isAvailable: true,
            OR: [{ locationId: null }, { locationId: 'loc-1' }],
          },
          orderBy: { totalOrders: 'desc' },
        },
      },
    }));
    expect(prisma.businessProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessProfileId: 'biz-1',
        catalogSectionId: null,
        OR: [{ locationId: null }, { locationId: 'loc-1' }],
      }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, locationId: 'loc-1' }));
  });

  test('invalid location cannot be used to probe another business menu', async () => {
    const prisma = {
      businessProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'biz-1', isSuspended: false }),
      },
      businessLocation: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      catalogSection: { findMany: jest.fn() },
      businessProduct: { findMany: jest.fn() },
    };
    const req = { app: { get: () => prisma }, params: { bizId: 'BIZ-1' }, query: { locationId: 'loc-other' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.getPublicMenu(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Business location not found.' });
    expect(prisma.catalogSection.findMany).not.toHaveBeenCalled();
    expect(prisma.businessProduct.findMany).not.toHaveBeenCalled();
  });
});
