jest.mock('../src/config/readReplica', () => ({
    getReadPrisma: jest.fn(),
}));

const { getReadPrisma } = require('../src/config/readReplica');
const { getProfitBreakdown } = require('../controllers/adminProfitBreakdownController');

function makeRes() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

function makePrisma({ snapshots = [], logs = [], onGroupBy, onSnapshotFindMany } = {}) {
    return {
        systemProfitFees: { findUnique: jest.fn().mockResolvedValue({ balance: 12.5 }) },
        systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 50 }) },
        systemHotWallet: { findUnique: jest.fn().mockResolvedValue({ balance: 80 }) },
        systemMasterCrypto: { findUnique: jest.fn().mockResolvedValue({ balance: 100 }) },
        adminProfitLog: {
            groupBy: jest.fn(async (args) => {
                onGroupBy?.(args);
                return [{ source: 'TRADING_FEE', _sum: { amountUsdc: 20 }, _count: 2 }];
            }),
            findMany: jest.fn().mockResolvedValue(logs),
        },
        dailySnapshot: {
            findMany: jest.fn(async (args) => {
                onSnapshotFindMany?.(args);
                return snapshots;
            }),
        },
    };
}

describe('adminProfitBreakdownController', () => {
    afterEach(() => jest.clearAllMocks());

    test.each(['24h', '7d', '30d', '90d'])('accepts %s and applies the selected period to every time-bounded query', async (period) => {
        const snapshots = [{
            date: new Date('2026-09-02T00:00:00.000Z'),
            totalProfitUsdc: 4,
            totalVolumeUsdc: 100,
            activeUsers: 7,
            profitBySource: { TRADING_FEE: 4 },
        }];
        let groupByArgs;
        let snapshotArgs;
        const prisma = makePrisma({
            snapshots,
            onGroupBy: (args) => { groupByArgs = args; },
            onSnapshotFindMany: (args) => { snapshotArgs = args; },
        });
        getReadPrisma.mockReturnValue(prisma);
        const req = { app: {}, query: { period } };
        const res = makeRes();

        await getProfitBreakdown(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                dailyPnl: expect.any(Array),
                totalProfit: 20,
                totalTransactions: 2,
                period: expect.objectContaining({ key: period }),
            }),
        }));

        expect(groupByArgs?.where?.createdAt?.gte).toBeInstanceOf(Date);
        expect(snapshotArgs?.where?.date?.gte).toBeInstanceOf(Date);
        expect(snapshotArgs.where.date.gte.getTime()).toBe(groupByArgs.where.createdAt.gte.getTime());
    });

    test('rejects an unknown period instead of silently showing another period', async () => {
        getReadPrisma.mockReturnValue(makePrisma());
        const res = makeRes();

        await getProfitBreakdown({ app: {}, query: { period: 'all-time' } }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'Invalid profit period. Use one of: 24h, 7d, 30d, 90d.',
            allowedPeriods: ['24h', '7d', '30d', '90d'],
        });
    });

    test('uses profit logs for chart data when snapshots are unavailable', async () => {
        const createdAt = new Date('2026-09-02T12:00:00.000Z');
        const prisma = makePrisma({
            snapshots: [],
            logs: [
                { amountUsdc: 3, source: 'TRADING_FEE', createdAt },
                { amountUsdc: 2, source: 'WITHDRAWAL_FEE', createdAt: new Date('2026-09-02T15:00:00.000Z') },
            ],
        });
        getReadPrisma.mockReturnValue(prisma);
        const res = makeRes();

        await getProfitBreakdown({ app: {}, query: { period: '7d' } }, res);

        const payload = res.json.mock.calls[0][0].data;
        expect(payload.dailyPnl).toEqual([
            expect.objectContaining({ date: '2026-09-02', profit: 5, volume: 0, users: 0 }),
        ]);
        expect(prisma.adminProfitLog.findMany).toHaveBeenCalledTimes(1);
    });
});
