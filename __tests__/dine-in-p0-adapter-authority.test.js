'use strict';

const notifyDineInEvent = jest.fn().mockResolvedValue(null);
const addItemAtomically = jest.fn();
const addCustomerItemAtomically = jest.fn();
const removeItemAtomically = jest.fn();
const confirmAndPay = jest.fn();
const getTab = jest.fn();
const confirmTab = jest.fn();

jest.mock('../services/bizNotificationService', () => ({
  notifyDineInEvent,
}));

jest.mock('../services/dineInTabMutationService', () => ({
  addItem: addItemAtomically,
  addCustomerItem: addCustomerItemAtomically,
  removeItem: removeItemAtomically,
}));

jest.mock('../services/marketplace/dineInService', () => jest.fn().mockImplementation(() => ({
  confirmAndPay,
  getTab,
  confirmTab,
})));

const dineInTabService = require('../services/dineInTabService');

describe('dine-in adapter authority boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normal payment uses the canonical service, preserves customer authority, and emits one business lifecycle notification', async () => {
    const prisma = {};
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    const tab = { id: 'tab-1', customerId: 7, businessProfileId: 'biz-1', status: 'CLOSED', grandTotalUsdc: 42 };
    const invoice = { id: 'inv-1', status: 'PAID' };
    confirmAndPay.mockResolvedValue({
      tab,
      invoice,
      payment: { alreadyPaid: false, customerPays: 42, businessReceives: 41.37, fee: 0.63 },
    });

    const result = await dineInTabService.confirmAndPay(prisma, {
      tabId: 'tab-1', customerId: 7, tipUsdc: 2, io,
    });

    expect(confirmAndPay).toHaveBeenCalledWith('tab-1', 7, { tipUsdc: 2 });
    expect(result.tab).toBe(tab);
    expect(result.invoice).toBe(invoice);
    expect(notifyDineInEvent).toHaveBeenCalledTimes(1);
    expect(notifyDineInEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
      businessProfileId: 'biz-1',
      tabId: 'tab-1',
      type: 'DINE_IN_TAB_PAID',
      totalAmount: 42,
      io,
    }));
    expect(io.to).not.toHaveBeenCalled();
  });

  test('ambiguous payment recovers only from durable CLOSED + PAID state and never recharges', async () => {
    const prisma = {};
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    confirmAndPay.mockRejectedValue(new Error('response lost after commit'));
    getTab.mockResolvedValue({
      id: 'tab-1',
      customerId: 7,
      businessProfileId: 'biz-1',
      status: 'CLOSED',
      invoice: {
        id: 'inv-1',
        status: 'PAID',
        billTotalUsdc: 40,
        tipUsdc: 2,
        feeUsdc: 0.63,
        customerCoveredFee: false,
        customerPaidUsdc: 42,
        payTxHash: 'INV_PAY_inv-1',
      },
    });

    const result = await dineInTabService.confirmAndPay(prisma, {
      tabId: 'tab-1', customerId: 7, tipUsdc: 2, io,
    });

    expect(confirmAndPay).toHaveBeenCalledTimes(1);
    expect(getTab).toHaveBeenCalledWith('tab-1');
    expect(result.tab.status).toBe('CLOSED');
    expect(result.invoice.status).toBe('PAID');
    expect(result.payment.alreadyPaid).toBe(true);
    expect(result.payment.customerPays).toBe(42);
    expect(result.payment.businessReceives).toBe(41.37);
    expect(result.payment.fee).toBe(0.63);
    expect(notifyDineInEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
      businessProfileId: 'biz-1',
      tabId: 'tab-1',
      type: 'DINE_IN_TAB_PAID',
      totalAmount: 42,
      extraMetadata: { invoiceId: 'inv-1' },
      io,
    }));
  });

  test('durable recovery cannot be used for a paid tab owned by another customer', async () => {
    const prisma = {};
    confirmAndPay.mockRejectedValue(new Error('payment transport failure'));
    getTab.mockResolvedValue({
      id: 'tab-1', customerId: 99, status: 'CLOSED',
      invoice: { id: 'inv-1', status: 'PAID', customerPaidUsdc: 42, payTxHash: 'INV_PAY_inv-1' },
    });

    await expect(dineInTabService.confirmAndPay(prisma, {
      tabId: 'tab-1', customerId: 7,
    })).rejects.toThrow('payment transport failure');

    expect(notifyDineInEvent).not.toHaveBeenCalled();
  });
});
