'use strict';

jest.mock('../services/businessInvoiceService', () => ({
  createInvoice: jest.fn(),
  sendInvoice: jest.fn(),
  payInvoice: jest.fn(),
}));

const invoiceService = require('../services/businessInvoiceService');
const DineInService = require('../services/marketplace/dineInService');

describe('dine-in lifecycle orchestration', () => {
  beforeEach(() => jest.clearAllMocks());

  test('FINALIZED -> invoice -> PAID -> CLOSED with tip preserves the same settlement authority', async () => {
    const invoice = {
      id: 'inv-1',
      status: 'SENT',
      billTotalUsdc: 40,
      businessProfile: { userId: 99 },
    };
    const paidInvoice = {
      ...invoice,
      status: 'PAID',
      tipUsdc: 2,
      customerPaidUsdc: 42,
      payTxHash: 'INV_PAY_inv-1',
    };
    const items = [{ name: 'Jollof', quantity: 1, unitPriceUsdc: 40 }];
    const beforeInvoice = {
      id: 'tab-1', customerId: 7, businessProfileId: 'biz-1', locationId: null, tableId: null,
      status: 'FINALIZED', items, invoice: null,
    };
    const afterInvoice = { ...beforeInvoice, invoice };
    const closed = {
      ...afterInvoice,
      status: 'CLOSED', grandTotalUsdc: 42, invoice: paidInvoice,
    };

    const scopedFindUnique = jest.fn().mockResolvedValue(closed);
    const tx = {
      dineInTab: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: scopedFindUnique,
      },
      businessInvoice: {},
      user: {},
      systemProfitFees: {},
      adminProfitLog: {},
      transactionHistory: {},
    };
    const prisma = {
      dineInTab: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(beforeInvoice)
          .mockResolvedValueOnce(afterInvoice),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };

    invoiceService.createInvoice.mockResolvedValue({ id: 'inv-1', ...invoice });
    invoiceService.payInvoice.mockResolvedValue({
      invoice: paidInvoice,
      customerPays: 42,
      businessReceives: 41.37,
      fee: 0.63,
    });

    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    const service = new DineInService(prisma, io);
    const result = await service.confirmAndPay('tab-1', 7, { tipUsdc: 2 });

    expect(invoiceService.createInvoice).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        businessProfileId: 'biz-1',
        customerId: 7,
        lineItems: [{ description: 'Jollof', quantity: 1, unitPrice: 40 }],
        idempotencyKey: 'DINE_IN_TAB:tab-1',
      }),
    );
    expect(invoiceService.payInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv-1', customerId: 7, tipUsdc: 2 }),
    );
    expect(tx.dineInTab.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tab-1', status: 'FINALIZED', invoiceId: 'inv-1' },
      data: expect.objectContaining({ status: 'CLOSED', tipUsdc: 2, grandTotalUsdc: 42 }),
    }));
    expect(result.tab.status).toBe('CLOSED');
    expect(result.tab.grandTotalUsdc).toBe(42);
    expect(result.invoice.status).toBe('PAID');
    expect(result.payment.customerPays).toBe(42);
    expect(result.payment.businessReceives).toBe(41.37);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(io.to).toHaveBeenCalledWith('user_7');
  });

  test('paid replay returns the durable PAID invoice without charging again', async () => {
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-1', customerId: 7, status: 'CLOSED', items: [],
          invoice: { id: 'inv-1', status: 'PAID', customerPaidUsdc: 42, payTxHash: 'INV_PAY_inv-1' },
        }),
      },
    };
    const service = new DineInService(prisma);

    const result = await service.confirmAndPay('tab-1', 7, { tipUsdc: 2 });

    expect(result.payment.alreadyPaid).toBe(true);
    expect(result.payment.customerPays).toBe(42);
    expect(invoiceService.payInvoice).not.toHaveBeenCalled();
  });
});
