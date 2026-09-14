'use strict';

const mockNotifyDineInEvent = jest.fn().mockResolvedValue(null);
const mockAddItem = jest.fn();
const mockAddCustomerItem = jest.fn();
const mockRemoveItem = jest.fn();
const mockConfirmAndPay = jest.fn();
const mockGetTab = jest.fn();
const mockConfirmTab = jest.fn();

jest.mock('../services/bizNotificationService', () => ({
  notifyDineInEvent: mockNotifyDineInEvent,
}));

jest.mock('../services/dineInTabMutationService', () => ({
  addItem: mockAddItem,
  addCustomerItem: mockAddCustomerItem,
  removeItem: mockRemoveItem,
}));

jest.mock('../services/marketplace/dineInService', () => jest.fn().mockImplementation(() => ({
  confirmAndPay: mockConfirmAndPay,
  getTab: mockGetTab,
  confirmTab: mockConfirmTab,
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
    mockConfirmAndPay.mockResolvedValue({
      tab,
      invoice,
      payment: { alreadyPaid: false, customerPays: 42, businessReceives: 41.37, fee: 0.63 },
    });

    const result = await dineInTabService.confirmAndPay(prisma, {
      tabId: 'tab-1', customerId: 7, tipUsdc: 2, io,
    });

    expect(mockConfirmAndPay).toHaveBeenCalledWith('tab-1', 7, { tipUsdc: 2 });
    expect(result.tab).toBe(tab);
    expect(result.invoice).toBe(invoice);
    expect(mockNotifyDineInEvent).toHaveBeenCalledTimes(1);
    expect(mockNotifyDineInEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
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
    mockConfirmAndPay.mockRejectedValue(new Error('response lost after commit'));
    mockGetTab.mockResolvedValue({
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

    expect(mockConfirmAndPay).toHaveBeenCalledTimes(1);
    expect(mockGetTab).toHaveBeenCalledWith('tab-1');
    expect(result.tab.status).toBe('CLOSED');
    expect(result.invoice.status).toBe('PAID');
    expect(result.payment.alreadyPaid).toBe(true);
    expect(result.payment.customerPays).toBe(42);
    expect(result.payment.businessReceives).toBe(41.37);
    expect(result.payment.fee).toBe(0.63);
    expect(mockNotifyDineInEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
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
    mockConfirmAndPay.mockRejectedValue(new Error('payment transport failure'));
    mockGetTab.mockResolvedValue({
      id: 'tab-1', customerId: 99, status: 'CLOSED',
      invoice: { id: 'inv-1', status: 'PAID', customerPaidUsdc: 42, payTxHash: 'INV_PAY_inv-1' },
    });

    await expect(dineInTabService.confirmAndPay(prisma, {
      tabId: 'tab-1', customerId: 7,
    })).rejects.toThrow('payment transport failure');

    expect(mockNotifyDineInEvent).not.toHaveBeenCalled();
  });
});
