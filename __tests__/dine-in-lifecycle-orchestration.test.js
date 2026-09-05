'use strict';

jest.mock('../services/businessInvoiceService', () => ({
  createInvoice: jest.fn(),
  sendInvoice: jest.fn(),
  payInvoice: jest.fn(),
}));

const invoiceService = require('../services/businessInvoiceService');
const DineInService = require('../services/marketplace/dineInService');

describe('dine-in lifecycle orchestration', () => {
  test('OPEN -> add item -> FINALIZED -> invoice -> PAID -> CLOSED with tip', async () => {
    const customer = { id: 7, username: 'customer' };
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

    const txTab = {
      id: 'tab-1',
      customerId: 7,
      businessProfileId: 'biz-1',
      locationId: null,
      tableId: null,
      status: 'CLOSED',
      grandTotalUsdc: 42,
      items: [{ name: 'Jollof', quantity: 1, unitPriceUsdc: 40 }],
      invoice: paidInvoice,
    };

    const prisma = {
      $transaction: jest.fn(async (callback) => callback({
        dineInTab: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              id: 'tab-1',
              customerId: 7,
              businessProfileId: 'biz-1',
              locationId: null,
              tableId: null,
              status: 'FINALIZED',
              items: txTab.items,
              invoice: null,
            })
            .mockResolvedValueOnce(txTab),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        businessInvoice: {},
        user: {},
        systemProfitFees: {},
        adminProfitLog: {},
        transactionHistory: {},
      }),
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-1',
          customerId: 7,
          businessProfileId: 'biz-1',
          locationId: null,
          tableId: null,
          status: 'FINALIZED',
          items: txTab.items,
          invoice: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    invoiceService.createInvoice.mockResolvedValue({ id: 'inv-1', ...invoice });
    invoiceService.sendInvoice.mockResolvedValue(invoice);
    invoiceService.payInvoice.mockResolvedValue({
      invoice: paidInvoice,
      customerPays: 42,
      businessReceives: 41.37,
      fee: 0.63,
    });

    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    const service = new DineInService(prisma, io);
    const result = await service.confirmAndPay('tab-1', customer.id, { tipUsdc: 2 });

    expect(invoiceService.createInvoice).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        businessProfileId: 'biz-1',
        customerId: 7,
        lineItems: [{ description: 'Jollof', quantity: 1, unitPrice: 40 }],
        idempotencyKey: 'DINE_IN_TAB:tab-1',
      }),
    );
    expect(invoiceService.sendInvoice).not.toHaveBeenCalled();
    expect(invoiceService.payInvoice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv-1', customerId: 7, tipUsdc: 2 }),
    );
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
