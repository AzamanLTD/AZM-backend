const { payInvoice } = require('../services/businessInvoiceService');

describe('businessInvoiceService.payInvoice idempotency', () => {
  test('losing atomic claim replays the committed invoice without a second debit', async () => {
    const invoiceId = 'inv-1';
    const customerId = 7;
    const paidInvoice = {
      id: invoiceId,
      customerId,
      status: 'PAID',
      payTxHash: 'INV_PAY_inv-1',
      customerPaidUsdc: 10,
      businessProfile: { userId: 8, businessName: 'Test Biz', bizId: 'BIZ-1' },
    };

    const prisma = {
      businessInvoice: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({
            id: invoiceId,
            customerId,
            status: 'SENT',
            payTxHash: null,
            billTotalUsdc: 10,
            businessProfile: { userId: 8, businessName: 'Test Biz' },
          })
          .mockResolvedValueOnce(paidInvoice),
      },
      globalSettings: {
        findUnique: jest.fn().mockResolvedValue({ businessInvoiceFeePct: 0 }),
      },
      $transaction: jest.fn(async (callback) => callback({
        businessInvoice: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: jest.fn(),
        },
        user: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        transactionHistory: { create: jest.fn() },
        systemProfitFees: { upsert: jest.fn() },
        adminProfitLog: { create: jest.fn() },
      })),
    };

    const result = await payInvoice(prisma, { invoiceId, customerId });

    expect(result.alreadyPaid).toBe(true);
    expect(result.invoice.payTxHash).toBe('INV_PAY_inv-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
