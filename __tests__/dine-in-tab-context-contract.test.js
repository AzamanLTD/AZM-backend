describe('dine-in customer tab context contract', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('adapter instantiates the directly exported DineInService and enforces customer ownership', async () => {
    const getTab = jest.fn().mockResolvedValue({
      id: 'tab-1',
      customerId: 42,
      tableId: 'table-7',
    });

    jest.doMock('../services/marketplace/dineInService', () =>
      jest.fn().mockImplementation(() => ({ getTab })),
    );

    const adapter = require('../services/dineInTabService');
    await expect(adapter.getTab({}, { tabId: 'tab-1', customerId: 42 }))
      .resolves.toMatchObject({ id: 'tab-1', customerId: 42, tableId: 'table-7' });
    expect(getTab).toHaveBeenCalledWith('tab-1');

    await expect(adapter.getTab({}, { tabId: 'tab-1', customerId: 99 }))
      .rejects.toThrow('Not authorized to view this tab.');
  });

  test('customer tab controller enriches an existing table reference with the real table label', async () => {
    jest.doMock('../services/dineInTabService', () => ({
      getTab: jest.fn().mockResolvedValue({
        id: 'tab-1',
        customerId: 42,
        tableId: 'table-7',
        businessProfile: { id: 'biz-1', businessName: 'Table & Co', logoUrl: null },
        items: [],
      }),
    }));

    const controller = require('../controllers/dineInController');
    const req = {
      prisma: {
        businessTable: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'table-7',
            label: 'Table 7',
            locationId: 'location-1',
            isActive: true,
          }),
        },
      },
      user: { id: 42 },
      params: { tabId: 'tab-1' },
    };
    const json = jest.fn();
    const res = { json };

    await controller.getTab(req, res);

    expect(req.prisma.businessTable.findUnique).toHaveBeenCalledWith({
      where: { id: 'table-7' },
      select: { id: true, label: true, locationId: true, isActive: true },
    });
    expect(json).toHaveBeenCalledWith({
      success: true,
      tab: expect.objectContaining({
        tableId: 'table-7',
        table: {
          id: 'table-7',
          label: 'Table 7',
          locationId: 'location-1',
          isActive: true,
        },
      }),
    });
  });
});
