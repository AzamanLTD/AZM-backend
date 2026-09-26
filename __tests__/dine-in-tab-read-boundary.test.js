'use strict';

jest.mock('../services/marketplace/dineInService');
const DineInService = require('../services/marketplace/dineInService');
const dineInTabService = require('../services/dineInTabService');

describe('dine-in shared tab read authorization', () => {
  test('allows the owning business to read a customer tab', async () => {
    const getTab = jest.fn().mockResolvedValue({
      id: 'tab-1',
      customerId: 17,
      businessProfile: { id: 'biz-1' },
    });
    DineInService.mockImplementation(() => ({ getTab }));

    await expect(dineInTabService.getTab({}, {
      tabId: 'tab-1',
      businessProfileId: 'biz-1',
      customerId: 99,
    })).resolves.toEqual(expect.objectContaining({ id: 'tab-1' }));
  });

  test('allows only the owning customer when business context is absent', async () => {
    DineInService.mockImplementation(() => ({
      getTab: jest.fn().mockResolvedValue({
        id: 'tab-1',
        customerId: 17,
        businessProfile: { id: 'biz-1' },
      }),
    }));

    await expect(dineInTabService.getTab({}, {
      tabId: 'tab-1',
      customerId: 17,
    })).resolves.toEqual(expect.objectContaining({ id: 'tab-1' }));

    await expect(dineInTabService.getTab({}, {
      tabId: 'tab-1',
      customerId: 99,
    })).rejects.toThrow('Not authorized to view this tab.');
  });

  test('a different business cannot read another business tab', async () => {
    DineInService.mockImplementation(() => ({
      getTab: jest.fn().mockResolvedValue({
        id: 'tab-1',
        customerId: 17,
        businessProfile: { id: 'biz-owner' },
      }),
    }));

    await expect(dineInTabService.getTab({}, {
      tabId: 'tab-1',
      businessProfileId: 'biz-other',
      customerId: 99,
    })).rejects.toThrow('Not authorized to view this tab.');
  });
});
