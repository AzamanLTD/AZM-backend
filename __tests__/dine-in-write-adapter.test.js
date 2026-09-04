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

    const adapter = require('../services/dineInTabService');
    await adapter.addItem({}, {
      tabId: 'tab-1',
      productId: 'product-1',
      name: 'Jollof rice',
      unitPriceUsdc: '12.50',
      quantity: 2,
      notes: 'No pepper',
      userId: 42,
    });

    expect(addItem).toHaveBeenCalledWith({
      tabId: 'tab-1',
      productId: 'product-1',
      name: 'Jollof rice',
      price: '12.50',
      quantity: 2,
      notes: 'No pepper',
      addedBy: 42,
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
