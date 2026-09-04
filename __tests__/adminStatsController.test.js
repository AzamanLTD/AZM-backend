jest.mock('../src/config/readReplica', () => ({
  getReadPrisma: jest.fn(),
}));

const { getReadPrisma } = require('../src/config/readReplica');
const { getPlatformStats } = require('../controllers/adminStatsController');

describe('adminStatsController.getPlatformStats', () => {
  test('returns real 24h GHS fiat and USDC crypto volumes', async () => {
    const prisma = {
      user: { count: jest.fn().mockResolvedValue(42) },
      trade: {
        count: jest.fn().mockResolvedValue(3),
        aggregate: jest.fn()
          .mockResolvedValueOnce({ _sum: { amountFiat: 100000 } })
          .mockResolvedValueOnce({ _sum: { amountFiat: 2500.5 } })
          .mockResolvedValueOnce({ _sum: { amountCrypto: 175.25 } }),
      },
    };
    getReadPrisma.mockReturnValue(prisma);

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const req = { app: {} };

    await getPlatformStats(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.stats.totalUsers).toBe(42);
    expect(payload.stats.activeDisputes).toBe(3);
    expect(payload.stats.totalFiatVolume).toBe(100000);
    expect(payload.stats.fiatVolume24h).toBe(2500.5);
    expect(payload.stats.cryptoVolume24h).toBe(175.25);
    expect(payload.stats.currencies).toEqual({ fiat: 'GHS', crypto: 'USDC' });
    expect(payload.stats.totalAdminProfit).toBe('1500.00');

    expect(prisma.trade.aggregate).toHaveBeenNthCalledWith(1, {
      where: { status: 'COMPLETED', currency: 'GHS' },
      _sum: { amountFiat: true },
    });
    expect(prisma.trade.aggregate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: 'COMPLETED', currency: 'GHS', createdAt: expect.any(Object) }),
    }));
    expect(prisma.trade.aggregate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: expect.objectContaining({ status: 'COMPLETED', createdAt: expect.any(Object) }),
    }));
  });

  test('fails with a server error when a metrics query fails', async () => {
    const prisma = {
      user: { count: jest.fn().mockRejectedValue(new Error('db unavailable')) },
      trade: { count: jest.fn(), aggregate: jest.fn() },
    };
    getReadPrisma.mockReturnValue(prisma);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await getPlatformStats({ app: {} }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'db unavailable' });
  });
});
