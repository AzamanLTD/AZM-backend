'use strict';

jest.mock('../src/config/readReplica', () => ({
  getReadPrisma: jest.fn(),
}));

const { getReadPrisma } = require('../src/config/readReplica');
const { getDineInOverview } = require('../controllers/adminDineInController');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe('adminDineInController.getDineInOverview', () => {
  test('projects the full tab lifecycle with server-computed volumes', async () => {
    const recentTab = {
      id: 'tab-1',
      status: 'CLOSED',
      openedAt: new Date('2026-09-13T10:00:00Z'),
      closedAt: new Date('2026-09-13T10:45:00Z'),
      subtotalUsdc: 40,
      tipUsdc: 2,
      grandTotalUsdc: 42,
      paymentMethod: 'AZAMAN_BALANCE',
      invoice: { id: 'inv-1', status: 'PAID' },
      businessProfile: { id: 'biz-1', businessName: 'Azaman Grill' },
    };
    const prisma = {
      dineInTab: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'OPEN', _count: { _all: 3 } },
          { status: 'FINALIZED', _count: { _all: 1 } },
          { status: 'CLOSED', _count: { _all: 5 } },
        ]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotalUsdc: 128.5, tipUsdc: 6.25 } }),
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([recentTab]),
      },
    };
    getReadPrisma.mockReturnValue(prisma);

    const res = makeRes();
    await getDineInOverview({ app: {} }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);

    const overview = payload.overview;
    // Full lifecycle shape, including zero-defaulted CANCELLED.
    expect(overview.tabsByStatus).toEqual({ OPEN: 3, FINALIZED: 1, CLOSED: 5, CANCELLED: 0 });
    expect(overview.openTabs).toBe(3);
    expect(overview.finalizedTabs).toBe(1);
    expect(overview.closedToday).toBe(2);
    expect(overview.volume24h).toEqual({ totalUsdc: 128.5, tipsUsdc: 6.25 });
    expect(overview.currencies).toEqual({ crypto: 'USDC' });
    expect(typeof overview.generatedAt).toBe('string');

    // Recent tabs expose the business/invoice join needed for admin visibility.
    expect(overview.recentTabs).toEqual([recentTab]);

    // Volumes are computed from canonical CLOSED state only.
    expect(prisma.dineInTab.aggregate).toHaveBeenCalledWith({
      where: { status: 'CLOSED', closedAt: { gte: expect.any(Date) } },
      _sum: { grandTotalUsdc: true, tipUsdc: true },
    });
    expect(prisma.dineInTab.count).toHaveBeenCalledWith({
      where: { status: 'CLOSED', closedAt: { gte: expect.any(Date) } },
    });
    expect(prisma.dineInTab.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { openedAt: 'desc' },
      take: 15,
      select: expect.objectContaining({
        invoice: { select: { id: true, status: true } },
        businessProfile: { select: { id: true, businessName: true } },
      }),
    }));
  });

  test('returns an empty lifecycle projection when no tabs exist', async () => {
    const prisma = {
      dineInTab: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotalUsdc: null, tipUsdc: null } }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    getReadPrisma.mockReturnValue(prisma);

    const res = makeRes();
    await getDineInOverview({ app: {} }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const overview = res.json.mock.calls[0][0].overview;
    expect(overview.tabsByStatus).toEqual({ OPEN: 0, FINALIZED: 0, CLOSED: 0, CANCELLED: 0 });
    expect(overview.openTabs).toBe(0);
    expect(overview.finalizedTabs).toBe(0);
    expect(overview.closedToday).toBe(0);
    expect(overview.volume24h).toEqual({ totalUsdc: 0, tipsUsdc: 0 });
    expect(overview.recentTabs).toEqual([]);
  });

  test('fails with a server error when the projection query fails', async () => {
    const prisma = {
      dineInTab: {
        groupBy: jest.fn().mockRejectedValue(new Error('db unavailable')),
        aggregate: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };
    getReadPrisma.mockReturnValue(prisma);

    const res = makeRes();
    await getDineInOverview({ app: {} }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'db unavailable' });
  });
});
