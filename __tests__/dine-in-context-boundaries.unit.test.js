'use strict';

jest.mock('../services/businessInvoiceService', () => ({
  createInvoice: jest.fn(),
  sendInvoice: jest.fn(),
  payInvoice: jest.fn(),
}));

const DineInService = require('../services/marketplace/dineInService');

describe('DineInService context boundaries', () => {
  test('openTab validates active business-owned location and exact-location table', async () => {
    const tx = {
      businessLocation: { findFirst: jest.fn().mockResolvedValue({ id: 'loc-1' }) },
      businessTable: { findFirst: jest.fn().mockResolvedValue({ id: 'table-1' }) },
      dineInTab: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tab-1', customerId: 7, locationId: 'loc-1', tableId: 'table-1', items: [] }),
      },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 7, username: 'customer' }) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    const result = await new DineInService(prisma).openTab({
      businessProfileId: 'biz-1', azamanId: 'AZM-7', locationId: 'loc-1', tableId: 'table-1',
    });

    expect(result.locationId).toBe('loc-1');
    expect(result.tableId).toBe('table-1');
    expect(tx.businessLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc-1', businessProfileId: 'biz-1', isActive: true },
      select: { id: true },
    });
    expect(tx.businessTable.findFirst).toHaveBeenCalledWith({
      where: { id: 'table-1', locationId: 'loc-1', isActive: true },
      select: { id: true },
    });
    expect(tx.dineInTab.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ businessProfileId: 'biz-1', locationId: 'loc-1', tableId: 'table-1' }),
    }));
  });

  test('openTab rejects a table without a location before querying a customer', async () => {
    const prisma = {
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };

    await expect(new DineInService(prisma).openTab({
      businessProfileId: 'biz-1', azamanId: 'AZM-7', tableId: 'table-1',
    })).rejects.toThrow('tableId requires locationId.');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('business-side item pricing rejects a branch product outside the tab location', async () => {
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-1', businessProfileId: 'biz-1', locationId: 'loc-1', customerId: 7, status: 'OPEN',
        }),
      },
      businessProduct: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(new DineInService(prisma).addItem({
      tabId: 'tab-1', productId: 'branch-prod', name: 'Branch meal', price: 10, quantity: 1, addedBy: 42,
    })).rejects.toThrow('Product is unavailable for this restaurant/location.');

    expect(prisma.businessProduct.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'branch-prod', businessProfileId: 'biz-1', isActive: true, isAvailable: true,
        OR: [{ locationId: null }, { locationId: 'loc-1' }],
      },
      select: { id: true, name: true, priceUsdc: true },
    });
  });

  test('legacy locationless tabs can only use global products', async () => {
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-legacy', businessProfileId: 'biz-1', locationId: null, customerId: 7, status: 'OPEN',
        }),
      },
      businessProduct: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await expect(new DineInService(prisma).addItem({
      tabId: 'tab-legacy', productId: 'branch-prod', name: 'Branch meal', price: 10, quantity: 1, addedBy: 42,
    })).rejects.toThrow('Product is unavailable for this restaurant/location.');

    expect(prisma.businessProduct.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'branch-prod', businessProfileId: 'biz-1', isActive: true, isAvailable: true,
        locationId: null,
      },
      select: { id: true, name: true, priceUsdc: true },
    });
  });

  test('customer item pricing uses the same branch/global product boundary', async () => {
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-1', businessProfileId: 'biz-1', locationId: 'loc-2', customerId: 7, status: 'OPEN',
        }),
      },
      businessProduct: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await expect(new DineInService(prisma).addCustomerItem({
      tabId: 'tab-1', customerId: 7, productId: 'branch-prod', quantity: 1,
    })).rejects.toThrow('Product is unavailable for this restaurant/location.');

    expect(prisma.businessProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        businessProfileId: 'biz-1',
        OR: [{ locationId: null }, { locationId: 'loc-2' }],
      }),
    }));
  });
});
