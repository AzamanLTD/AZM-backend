'use strict';

const DineInService = require('../services/marketplace/dineInService');

describe('dine-in business tab queue lifecycle', () => {
  test('default business queue contains only OPEN and FINALIZED tabs', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new DineInService({ dineInTab: { findMany } });

    await service.getBusinessTabs('biz-1');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        businessProfileId: 'biz-1',
        status: { in: ['OPEN', 'FINALIZED'] },
      },
    }));
  });

  test('explicit status remains authoritative for historical/admin views', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new DineInService({ dineInTab: { findMany } });

    await service.getBusinessTabs('biz-1', 'CLOSED');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        businessProfileId: 'biz-1',
        status: 'CLOSED',
      },
    }));
  });
});
