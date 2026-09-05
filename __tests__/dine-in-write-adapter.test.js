describe('dine-in tab service adapter', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('maps controller open-tab arguments to the domain service contract', async () => {
    const openTab = jest.fn().mockResolvedValue({ id: 'tab-1' });
    const Service = jest.fn().mockImplementation(() => ({ openTab }));
    jest.doMock('../services/marketplace/dineInService', () => Service);

    const adapter = require('../services/dineInTabService');
    await adapter.openTab({}, {
      businessProfileId: 'biz-1',
      customerAzamanId: 'AZM-123',
      locationId: 'location-1',
      tableId: 'table-7',
    });

    expect(openTab).toHaveBeenCalledWith({
      businessProfileId: 'biz-1',
      azamanId: 'AZM-123',
      locationId: 'location-1',
      tableId: 'table-7',
    });
  });

  test('maps item price and actor fields to addItem', async () => {
    const addItem = jest.fn().mockResolvedValue({ id: 'item-1' });
    jest.doMock('../services/marketplace/dineInService', () =>
      jest.fn().mockImplementation(() => ({ addItem })),
    );
    jest.doMock('../services/dineInTabMutationService', () => ({ addItem }));

    const adapter = require('../services/dineInTabService');
    const prisma = { marker: 'prisma' };
    const io = { marker: 'io' };
    await adapter.addItem(prisma, {
      tabId: 'tab-1',
      productId: 'product-1',
      name: 'Jollof rice',
      unitPriceUsdc: '12.50',
      quantity: 2,
      notes: 'No pepper',
      userId: 42,
      io,
    });

    expect(addItem).toHaveBeenCalledWith({
      tabId: 'tab-1',
      productId: 'product-1',
      name: 'Jollof rice',
      price: '12.50',
      quantity: 2,
      addedBy: 42,
      io,
    });
  });

  test('rejects invalid item quantities before reaching the domain service', async () => {
    const addCustomerItem = jest.fn();
    jest.doMock('../services/marketplace/dineInService', () =>
      jest.fn().mockImplementation(() => ({ addCustomerItem })),
    );

    const adapter = require('../services/dineInTabService');
    for (const quantity of [0, -1, 1.5, 51, 'not-a-number']) {
      await expect(adapter.addCustomerItem({}, {
        tabId: 'tab-1',
        customerId: 42,
        productId: 'product-1',
        quantity,
      })).rejects.toThrow('quantity must be an integer from 1 to 50.');
    }
    expect(addCustomerItem).not.toHaveBeenCalled();
  });

  test('normalizes omitted customer item quantity to one', async () => {
    const addCustomerItem = jest.fn().mockResolvedValue({ id: 'item-1' });
    jest.doMock('../services/marketplace/dineInService', () =>
      jest.fn().mockImplementation(() => ({ addCustomerItem })),
    );
    jest.doMock('../services/dineInTabMutationService', () => ({ addCustomerItem }));

    const adapter = require('../services/dineInTabService');
    const prisma = { marker: 'prisma' };
    const io = { marker: 'io' };
    await adapter.addCustomerItem(prisma, {
      tabId: 'tab-1',
      customerId: 42,
      productId: 'product-1',
      io,
    });

    expect(addCustomerItem).toHaveBeenCalledWith({
      tabId: 'tab-1',
      customerId: 42,
      productId: 'product-1',
      selection: undefined,
      quantity: 1,
      io,
    });
  });

  test('maps finalize and business tab reads to their domain methods', async () => {
    const finalizeTab = jest.fn().mockResolvedValue({ id: 'tab-1' });
    const getBusinessTabs = jest.fn().mockResolvedValue([]);
    jest.doMock('../services/marketplace/dineInService', () =>
      jest.fn().mockImplementation(() => ({ finalizeTab, getBusinessTabs })),
    );

    const adapter = require('../services/dineInTabService');
    await adapter.finalizeTab({}, { tabId: 'tab-1', userId: 42, taxRatePct: 5, tipUsdc: 1 });
    await adapter.getOpenTabs({}, { businessProfileId: 'biz-1', status: 'OPEN' });

    expect(finalizeTab).toHaveBeenCalledWith('tab-1');
    expect(getBusinessTabs).toHaveBeenCalledWith('biz-1', 'OPEN');
  });

  test('maps customer confirmation to the domain confirmation operation', async () => {
    const confirmTab = jest.fn().mockResolvedValue({ id: 'tab-1', status: 'CLOSED' });
    jest.doMock('../services/marketplace/dineInService', () =>
      jest.fn().mockImplementation(() => ({ confirmTab })),
    );

    const adapter = require('../services/dineInTabService');
    await adapter.confirmTab({}, { tabId: 'tab-1', customerId: 42 });
    await adapter.confirmAndPay({}, { tabId: 'tab-1', customerId: 42 });

    expect(confirmTab).toHaveBeenNthCalledWith(1, 'tab-1', 42);
    expect(confirmTab).toHaveBeenNthCalledWith(2, 'tab-1', 42);
  });
});
