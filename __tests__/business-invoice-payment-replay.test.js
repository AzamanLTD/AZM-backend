const { payInvoice } = require('../services/businessInvoiceService');

describe('businessInvoiceService.payInvoice committed replay', () => {
  test('returns the existing paid invoice without entering a financial transaction', async () => {
    const invoice = {
      id: 'inv-paid',
      customerId: 7,
      status: 'PAID',
      payTxHash: 'INV_PAY_inv-paid',
      customerPaidUsdc: 12.5,
      businessProfile: { userId: 8, businessName: 'Test Biz' },
    };

    const prisma = {
      businessInvoice: {
        findUnique: jest.fn().mockResolvedValue(invoice),
      },
      $transaction: jest.fn(),
    };

    const result = await payInvoice(prisma, {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
    });

    expect(result.alreadyPaid).toBe(true);
    expect(result.invoice).toBe(invoice);
    expect(result.customerPays).toBe(12.5);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
