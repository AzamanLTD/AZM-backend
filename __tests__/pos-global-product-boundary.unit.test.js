'use strict';

const { PosOrderService } = require('../services/businessOS/posOrderService');

describe('POS global/branch product boundary', () => {
  test('locationless POS pricing only queries global products', async () => {
    const tx = {
      businessProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'global-1', name: 'Global Item', priceUsdc: 12, stockQty: null }),
      },
    };
    const service = new PosOrderService({});

    const priced = await service._priceItems(tx, 'biz-1', [{ productId: 'global-1', quantity: 2 }], null);

    expect(priced.subtotal).toBe(24);
    expect(tx.businessProduct.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'global-1',
        businessProfileId: 'biz-1',
        isActive: true,
        isAvailable: true,
        locationId: null,
      },
      select: { id: true, name: true, priceUsdc: true, stockQty: true },
    });
  });

  test('location-scoped POS pricing still permits global and exact-location products', async () => {
    const tx = {
      businessProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: 'branch-1', name: 'Branch Item', priceUsdc: 15, stockQty: null }),
      },
    };
    const service = new PosOrderService({});

    await service._priceItems(tx, 'biz-1', [{ productId: 'branch-1', quantity: 1 }], 'loc-1');

    expect(tx.businessProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'branch-1',
        businessProfileId: 'biz-1',
        OR: [{ locationId: null }, { locationId: 'loc-1' }],
      }),
    }));
  });
});
