describe('dine-in customer ordering and settlement', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('customer item is authorized, validated and server-priced from product configuration', async () => {
    const addItem = jest.fn().mockResolvedValue({ id: 'item-1', unitPriceUsdc: 14 });
    const DineInService = jest.fn().mockImplementation(() => ({
      addItem,
      addCustomerItem: undefined,
    }));
    jest.doMock('../services/businessInvoiceService', () => ({
      createInvoice: jest.fn(),
      sendInvoice: jest.fn(),
      payInvoice: jest.fn(),
    }));
    jest.doMock('../services/marketplace/dineInService', () => {
      const RealService = jest.requireActual('../services/marketplace/dineInService');
      return RealService;
    });
    void DineInService;

    const Service = require('../services/marketplace/dineInService');
    const prisma = {
      dineInTab: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({ id: 'tab-1', businessProfileId: 'biz-1', customerId: 7, status: 'OPEN' })
          .mockResolvedValueOnce({ id: 'tab-1', customerId: 7, status: 'OPEN' }),
      },
      businessProduct: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product-1',
          name: 'Burger',
          priceUsdc: 10,
          variants: [{ name: 'Size', required: true, options: [{ name: 'Large', priceDelta: 2 }] }],
          modifierGroups: [{ name: 'Extras', required: false, maxSelection: 2, options: [{ name: 'Cheese', priceDelta: 2 }] }],
          isActive: true,
          isAvailable: true,
        }),
      },
      io: undefined,
    };

    const service = new Service(prisma);
    service.addItem = addItem;

    await service.addCustomerItem({
      tabId: 'tab-1',
      customerId: 7,
      productId: 'product-1',
      selection: { Size: 'Large', Extras: ['Cheese'] },
      quantity: 2,
    });

    expect(prisma.businessProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'product-1',
        businessProfileId: 'biz-1',
        isActive: true,
        isAvailable: true,
      }),
    }));
    expect(addItem).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-1',
      productId: 'product-1',
      price: 14,
      quantity: 2,
      addedBy: 7,
    }));
  });

  test('finalizing a tab creates and sends exactly one canonical invoice and links it back', async () => {
    const createInvoice = jest.fn().mockResolvedValue({ id: 'invoice-1', billTotalUsdc: 20 });
    const sendInvoice = jest.fn().mockResolvedValue({ id: 'invoice-1', status: 'SENT' });
    jest.doMock('../services/businessInvoiceService', () => ({
      createInvoice,
      sendInvoice,
      payInvoice: jest.fn(),
    }));

    const Service = require('../services/marketplace/dineInService');
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-1', businessProfileId: 'biz-1', customerId: 7, locationId: 'loc-1', tableId: 'table-1',
          status: 'OPEN', items: [{ id: 'item-1', name: 'Burger', unitPriceUsdc: 10, quantity: 2 }],
        }),
        update: jest.fn()
          .mockResolvedValueOnce({ id: 'tab-1', status: 'FINALIZED', grandTotalUsdc: 20, items: [] })
          .mockResolvedValueOnce({ id: 'tab-1', status: 'FINALIZED', invoiceId: 'invoice-1', items: [] }),
      },
    };

    const service = new Service(prisma);
    const result = await service.finalizeTab('tab-1');

    expect(createInvoice).toHaveBeenCalledWith(prisma, expect.objectContaining({
      businessProfileId: 'biz-1',
      customerId: 7,
      locationId: 'loc-1',
      tableId: 'table-1',
      lineItems: [{ description: 'Burger', quantity: 2, unitPrice: 10 }],
      taxLines: [],
    }));
    expect(sendInvoice).toHaveBeenCalledWith(prisma, { invoiceId: 'invoice-1', businessProfileId: 'biz-1' });
    expect(prisma.dineInTab.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'tab-1' },
      data: { invoiceId: 'invoice-1' },
    }));
    expect(result.invoiceId).toBe('invoice-1');
  });

  test('customer payment uses invoice settlement and closes the tab', async () => {
    const payInvoice = jest.fn().mockResolvedValue({
      invoice: { id: 'invoice-1', status: 'PAID', billTotalUsdc: 20 },
      customerPays: 20,
      businessReceives: 19.7,
      fee: 0.3,
    });
    jest.doMock('../services/businessInvoiceService', () => ({
      createInvoice: jest.fn(),
      sendInvoice: jest.fn(),
      payInvoice,
    }));

    const Service = require('../services/marketplace/dineInService');
    const prisma = {
      dineInTab: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tab-1', customerId: 7, status: 'FINALIZED', businessProfileId: 'biz-1',
          locationId: 'loc-1', tableId: 'table-1', invoiceId: 'invoice-1',
          invoice: { id: 'invoice-1', status: 'SENT', billTotalUsdc: 20 },
          items: [{ name: 'Burger', unitPriceUsdc: 20, quantity: 1 }],
        }),
        update: jest.fn().mockResolvedValue({ id: 'tab-1', status: 'CLOSED' }),
      },
    };

    const service = new Service(prisma);
    const result = await service.confirmAndPay('tab-1', 7, { tipUsdc: 2 });

    expect(payInvoice).toHaveBeenCalledWith(prisma, {
      invoiceId: 'invoice-1', customerId: 7, tipUsdc: 2,
    });
    expect(prisma.dineInTab.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tab-1' },
      data: expect.objectContaining({
        status: 'CLOSED',
        tipUsdc: 2,
        grandTotalUsdc: 22,
        paymentMethod: 'AZAMAN_BALANCE',
      }),
    }));
    expect(result.invoice.status).toBe('PAID');
  });
});
