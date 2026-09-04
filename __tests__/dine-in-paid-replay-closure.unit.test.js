'use strict';

jest.mock('../services/marketplace/dineInService');
const DineInService = require('../services/marketplace/dineInService');
const service = require('../services/dineInTabService');

describe('dine-in paid replay closure recovery', () => {
  test('a paid replay closes a stale FINALIZED tab and returns the recovered tab', async () => {
    const confirmAndPay = jest.fn().mockResolvedValue({
      tab: { id: 'tab-1', status: 'FINALIZED' },
      invoice: { id: 'invoice-1', status: 'PAID' },
      payment: { alreadyPaid: true, customerPays: 45 },
    });
    const confirmTab = jest.fn().mockResolvedValue({ id: 'tab-1', status: 'CLOSED' });
    DineInService.mockImplementation(() => ({ confirmAndPay, confirmTab }));

    const prisma = {};
    const result = await service.confirmAndPay(prisma, {
      tabId: 'tab-1', customerId: 7, tipUsdc: 2,
    });

    expect(confirmAndPay).toHaveBeenCalledWith('tab-1', 7, { tipUsdc: 2 });
    expect(confirmTab).toHaveBeenCalledWith('tab-1', 7);
    expect(result.tab).toEqual({ id: 'tab-1', status: 'CLOSED' });
  });

  test('a normal successful payment does not run the recovery close a second time', async () => {
    const confirmAndPay = jest.fn().mockResolvedValue({
      tab: { id: 'tab-1', status: 'CLOSED' },
      invoice: { id: 'invoice-1', status: 'PAID' },
      payment: { alreadyPaid: false, customerPays: 45 },
    });
    const confirmTab = jest.fn();
    DineInService.mockImplementation(() => ({ confirmAndPay, confirmTab }));

    const result = await service.confirmAndPay({}, { tabId: 'tab-1', customerId: 7 });

    expect(result.tab.status).toBe('CLOSED');
    expect(confirmTab).not.toHaveBeenCalled();
  });
});
