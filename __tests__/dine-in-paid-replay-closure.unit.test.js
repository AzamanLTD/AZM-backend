'use strict';

jest.mock('../services/marketplace/dineInService');
const DineInService = require('../services/marketplace/dineInService');
const service = require('../services/dineInTabService');
const { notifyDineInEvent } = require('../services/bizNotificationService');

jest.mock('../services/bizNotificationService', () => ({
  notifyDineInEvent: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

describe('dine-in paid replay closure recovery', () => {
  beforeEach(() => jest.clearAllMocks());

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

  test('recovers a payment when a concurrent request already closed the tab and notifies the business owner', async () => {
    const confirmAndPay = jest.fn().mockRejectedValue(new Error('Tab could not be closed after payment; transaction rolled back.'));
    const getTab = jest.fn().mockResolvedValue({
      id: 'tab-1',
      customerId: 7,
      businessProfileId: 'biz-1',
      status: 'CLOSED',
      invoice: {
        id: 'invoice-1',
        status: 'PAID',
        payTxHash: 'INV_PAY_invoice-1',
        billTotalUsdc: 45,
        tipUsdc: 2,
        feeUsdc: 0.705,
        customerPaidUsdc: 47,
        customerCoveredFee: false,
      },
    });
    DineInService.mockImplementation(() => ({ confirmAndPay, getTab }));

    const result = await service.confirmAndPay({}, { tabId: 'tab-1', customerId: 7, tipUsdc: 2, io: { to: jest.fn() } });

    expect(getTab).toHaveBeenCalledWith('tab-1');
    expect(result.tab.status).toBe('CLOSED');
    expect(result.payment.alreadyPaid).toBe(true);
    expect(result.payment.customerPays).toBe(47);
    expect(result.payment.businessReceives).toBeCloseTo(46.295, 8);
    expect(notifyDineInEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessProfileId: 'biz-1',
      tabId: 'tab-1',
      type: 'DINE_IN_TAB_PAID',
      totalAmount: 47,
      extraMetadata: { invoiceId: 'invoice-1' },
    }));
  });

  test('does not swallow a failed payment when the durable state is not paid', async () => {
    const failure = new Error('INSUFFICIENT_FUNDS');
    const confirmAndPay = jest.fn().mockRejectedValue(failure);
    const getTab = jest.fn().mockResolvedValue({
      id: 'tab-1',
      customerId: 7,
      status: 'FINALIZED',
      invoice: { id: 'invoice-1', status: 'SENT', payTxHash: null },
    });
    DineInService.mockImplementation(() => ({ confirmAndPay, getTab }));

    await expect(service.confirmAndPay({}, { tabId: 'tab-1', customerId: 7 })).rejects.toBe(failure);
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
