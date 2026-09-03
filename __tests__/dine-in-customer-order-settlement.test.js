describe('dine-in customer ordering and settlement', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('customer item is authorized, validated and server-priced from product configuration', async () => {
    jest.doMock('../services/businessInvoiceService', () => ({ createInvoice: jest.fn(), sendInvoice: jest.fn(), payInvoice: jest.fn() }));
    const Service = require('../services/marketplace/dineInService');
    const addItem = jest.fn().mockResolvedValue({ id: 'item-1', unitPriceUsdc: 14 });
    const prisma = {
      dineInTab: { findUnique: jest.fn().mockResolvedValue({ id: 'tab-1', businessProfileId: 'biz-1', customerId: 7, status: 'OPEN' }) },
      businessProduct: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product-1', name: 'Burger', priceUsdc: 10,
          variants: [{ name: 'Size', required: true, options: [{ name: 'Large', priceDelta: 2 }] }],
          modifierGroups: [{ name: 'Extras', required: false, maxSelection: 2, options: [{ name: 'Cheese', priceDelta: 2 }] }],
          isActive: true, isAvailable: true,
        }),
      },
    };
    const service = new Service(prisma);
    service.addItem = addItem;

    await service.addCustomerItem({ tabId: 'tab-1', customerId: 7, productId: 'product-1', selection: { Size: 'Large', Extras: ['Cheese'] }, quantity: 2 });

    expect(prisma.businessProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'product-1', businessProfileId: 'biz-1', isActive: true, isAvailable: true }),
    }));
    expect(addItem).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-1', productId: 'product-1', price: 14, quantity: 2, addedBy: 7 }));
  });

  test('finalizing a tab does not create or send an invoice', async () => {
    const createInvoice = jest.fn();
    const sendInvoice = jest.fn();
    jest.doMock('../services/businessInvoiceService', () => ({ createInvoice, sendInvoice, payInvoice: jest.fn() }));
    const Service = require('../services/marketplace/dineInService');
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tab-1', businessProfileId: 'biz-1', customerId: 7, status: 'OPEN', items: [{ id: 'item-1', name: 'Burger', unitPriceUsdc: 10, quantity: 2 }] }),
        update: jest.fn().mockResolvedValue({ id: 'tab-1', status: 'FINALIZED', grandTotalUsdc: 20, items: [] }),
      },
    };

    const result = await new Service(prisma).finalizeTab('tab-1');

    expect(result.status).toBe('FINALIZED');
    expect(result.grandTotalUsdc).toBe(20);
    expect(createInvoice).not.toHaveBeenCalled();
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  test('customer payment creates, sends, settles and links the canonical invoice', async () => {
    const createInvoice = jest.fn().mockResolvedValue({ id: 'invoice-1', billTotalUsdc: 20, status: 'DRAFT' });
    const sendInvoice = jest.fn().mockResolvedValue({ id: 'invoice-1', status: 'SENT', billTotalUsdc: 20 });
    const payInvoice = jest.fn().mockResolvedValue({ invoice: { id: 'invoice-1', status: 'PAID', billTotalUsdc: 20, tipUsdc: 2 }, customerPays: 22, businessReceives: 21.7, fee: 0.3 });
    jest.doMock('../services/businessInvoiceService', () => ({ createInvoice, sendInvoice, payInvoice }));
    const Service = require('../services/marketplace/dineInService');
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(prisma)),
      dineInTab: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({ id: 'tab-1', customerId: 7, status: 'FINALIZED', businessProfileId: 'biz-1', locationId: 'loc-1', tableId: 'table-1', invoice: null, items: [{ name: 'Burger', unitPriceUsdc: 20, quantity: 1 }] })
          .mockResolvedValueOnce({ id: 'tab-1', businessProfileId: 'biz-1', status: 'FINALIZED', invoiceId: 'invoice-1', items: [], invoice: { id: 'invoice-1', status: 'DRAFT', billTotalUsdc: 20 } })
          .mockResolvedValue({ id: 'tab-1', status: 'CLOSED', invoiceId: 'invoice-1', items: [], invoice: { id: 'invoice-1', status: 'PAID', billTotalUsdc: 20, tipUsdc: 2 } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await new Service(prisma).confirmAndPay('tab-1', 7, { tipUsdc: 2 });

    expect(createInvoice).toHaveBeenCalledWith(prisma, expect.objectContaining({
      businessProfileId: 'biz-1', customerId: 7, locationId: 'loc-1', tableId: 'table-1',
      lineItems: [{ description: 'Burger', quantity: 1, unitPrice: 20 }], taxLines: [],
    }));
    expect(sendInvoice).toHaveBeenCalledWith(prisma, { invoiceId: 'invoice-1', businessProfileId: 'biz-1' });
    expect(payInvoice).toHaveBeenCalledWith(expect.objectContaining({
      dineInTab: prisma.dineInTab,
    }), { invoiceId: 'invoice-1', customerId: 7, tipUsdc: 2 });
    expect(prisma.dineInTab.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'tab-1', status: 'FINALIZED', invoiceId: 'invoice-1' },
      data: expect.objectContaining({ status: 'CLOSED', tipUsdc: 2, grandTotalUsdc: 22, paymentMethod: 'AZAMAN_BALANCE' }),
    }));
    expect(result.invoice.status).toBe('PAID');
  });
});
