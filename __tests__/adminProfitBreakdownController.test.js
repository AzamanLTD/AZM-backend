jest.mock('../src/config/readReplica', () => ({
    getReadPrisma: jest.fn(),
}));
jest.mock('../src/services/fiatLiquidityActivationService', () => ({
    readMode: jest.fn().mockResolvedValue({ active: false, flagged: false, latched: false, activatedAt: null, currency: 'USDC' }),
    readModeAndPool: jest.fn().mockResolvedValue({ active: false, flagged: false, latched: false, activatedAt: null, currency: 'USDC', balance: 0 }),
    lockRegime: jest.fn().mockResolvedValue(undefined),
}));

const { getReadPrisma } = require('../src/config/readReplica');
const { getProfitBreakdown } = require('../controllers/adminProfitBreakdownController');
const adminController = require('../controllers/adminController');

function makeRes() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Rows as services/profitRevenueService.readRows returns them: AdminProfitLog
 * grouped by UTC day, source and kind (a reversal's amount is its magnitude).
 */
function sampleRows() {
    const d1 = daysAgo(2);
    const d2 = today();
    return [
        // A settled cash-out of 1000 USDC by a referred customer: 20 fee, half
        // to Azaman, half to the referrer, and the principal logged as
        // ARBITRAGE_SPREAD.
        { day: d1, source: 'ARBITRAGE_SPREAD', kind: 'WITHDRAWAL_PRINCIPAL', n: 1, amount: '1000' },
        { day: d1, source: 'EXIT_FEE', kind: 'REVENUE', n: 1, amount: '10' },
        { day: d1, source: 'EXIT_FEE', kind: 'REFERRER_PAYOUT', n: 1, amount: '10' },
        // A P2P trade and a hotel stay fee.
        { day: d1, source: 'P2P_MARGIN', kind: 'REVENUE', n: 2, amount: '3.5' },
        { day: d2, source: 'SMART_ESCROW_FEE', kind: 'REVENUE', n: 1, amount: '2' },
        // The stay was cancelled by the business: the fee is refunded as a
        // negative row (magnitude here).
        { day: d2, source: 'SMART_ESCROW_FEE', kind: 'REVERSAL', n: 1, amount: '2' },
        // A crypto withdrawal charge, then its refund as a positive
        // isSubsidized row.
        { day: d2, source: 'GAS_FEE_REVENUE', kind: 'REVENUE', n: 2, amount: '0.06' },
        { day: d2, source: 'GAS_FEE_REVENUE', kind: 'REVERSAL', n: 1, amount: '0.03' },
        // The admin moved 5 USDC of profit into the fiat pool.
        { day: d2, source: 'ARBITRAGE_SPREAD', kind: 'PROFIT_LIQUIDATION', n: 1, amount: '5' },
    ];
}

function makePrisma({ rows = [], snapshots = [], onQueryRaw, onSnapshotFindMany } = {}) {
    return {
        systemProfitFees: { findUnique: jest.fn().mockResolvedValue({ balance: 12.5 }) },
        systemHotWallet: { findUnique: jest.fn().mockResolvedValue({ balance: 80 }) },
        systemMasterCrypto: { findUnique: jest.fn().mockResolvedValue({ balance: 100 }) },
        adminProfitLog: {
            groupBy: jest.fn(async () => { throw new Error('the breakdown must not sum every row by source'); }),
            findMany: jest.fn(async () => { throw new Error('the breakdown must not sum every row'); }),
        },
        $queryRaw: jest.fn(async (strings, ...values) => {
            onQueryRaw?.(strings, values);
            return rows;
        }),
        dailySnapshot: {
            findMany: jest.fn(async (args) => {
                onSnapshotFindMany?.(args);
                return snapshots;
            }),
        },
    };
}

async function run(prisma, period = '30d') {
    getReadPrisma.mockReturnValue(prisma);
    const res = makeRes();
    await getProfitBreakdown({ app: {}, query: { period } }, res);
    return res;
}

describe('adminProfitBreakdownController', () => {
    afterEach(() => jest.clearAllMocks());

    test.each([['24h', 1], ['7d', 7], ['30d', 30], ['90d', 90]])('accepts %s and applies the selected period to every time-bounded query', async (period, days) => {
        let rangeArgs;
        let snapshotArgs;
        const prisma = makePrisma({
            rows: sampleRows(),
            onQueryRaw: (strings, values) => { rangeArgs = values.filter((v) => v instanceof Date); },
            onSnapshotFindMany: (args) => { snapshotArgs = args; },
        });

        const res = await run(prisma, period);

        expect(res.status).toHaveBeenCalledWith(200);
        const data = res.json.mock.calls[0][0].data;
        expect(data.period.key).toBe(period);

        // The revenue query is bounded by [from, to) of the period.
        expect(rangeArgs).toHaveLength(2);
        const [from, to] = rangeArgs;
        expect(to.getTime() - from.getTime()).toBe(days * 24 * 60 * 60 * 1000);
        expect(from.toISOString()).toBe(data.period.from);
        expect(to.toISOString()).toBe(data.period.to);
        expect(snapshotArgs.where.date.gte.getTime()).toBe(from.getTime());
    });

    test('rejects an unknown period instead of silently showing another period', async () => {
        const res = await run(makePrisma(), 'all-time');

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'Invalid profit period. Use one of: 24h, 7d, 30d, 90d.',
            allowedPeriods: ['24h', '7d', '30d', '90d'],
        });
    });

    test('counts only what Azaman keeps: principal, liquidations and referrer payouts are left out, refunds net out', async () => {
        const res = await run(makePrisma({ rows: sampleRows() }));
        const data = res.json.mock.calls[0][0].data;

        // 10 (exit fee, Azaman's half) + 3.5 (P2P) + 0 (stay fee refunded)
        // + 0.03 (gas, one of two refunded) = 13.53. The old sum of every row
        // was 1032.59.
        expect(data.totalProfit).toBeCloseTo(13.53, 8);
        expect(data.totalTransactions).toBe(6);
        expect(data.sourceBreakdown).toEqual({
            EXIT_FEE: { totalUsdc: 10, count: 1, grossUsdc: 10, reversedUsdc: 0, reversalCount: 0 },
            GAS_FEE_REVENUE: { totalUsdc: 0.03, count: 2, grossUsdc: 0.06, reversedUsdc: 0.03, reversalCount: 1 },
            P2P_MARGIN: { totalUsdc: 3.5, count: 2, grossUsdc: 3.5, reversedUsdc: 0, reversalCount: 0 },
            SMART_ESCROW_FEE: { totalUsdc: 0, count: 1, grossUsdc: 2, reversedUsdc: 2, reversalCount: 1 },
        });
        expect(data.sourceBreakdown.ARBITRAGE_SPREAD).toBeUndefined();
        expect(data.reversals).toEqual({ totalUsdc: 2.03, count: 2 });

        // The left-out amounts stay visible, each with its reason.
        expect(data.excluded.totalUsdc).toBe(1015);
        expect(data.excluded.count).toBe(3);
        expect(data.excluded.items.map(({ key, source, totalUsdc, count }) => ({ key, source, totalUsdc, count }))).toEqual([
            { key: 'WITHDRAWAL_PRINCIPAL', source: 'ARBITRAGE_SPREAD', totalUsdc: 1000, count: 1 },
            { key: 'PROFIT_LIQUIDATION', source: 'ARBITRAGE_SPREAD', totalUsdc: 5, count: 1 },
            { key: 'REFERRER_PAYOUT', source: 'EXIT_FEE', totalUsdc: 10, count: 1 },
        ]);
        for (const item of data.excluded.items) {
            expect(item.label).toEqual(expect.any(String));
            expect(item.reason).toEqual(expect.any(String));
        }
    });

    test('the daily chart covers every day of the period and adds up to the total', async () => {
        const snapshotDay = daysAgo(2);
        const res = await run(makePrisma({
            rows: sampleRows(),
            snapshots: [{ date: new Date(`${snapshotDay}T00:00:00.000Z`), totalVolumeUsdc: 1500, activeUsers: 7 }],
        }), '7d');
        const data = res.json.mock.calls[0][0].data;

        // 7 days back from now spans 8 UTC calendar days (both ends partial).
        expect(data.dailyPnl).toHaveLength(8);
        expect(data.dailyPnl[0].date).toBe(daysAgo(7));
        expect(data.dailyPnl[data.dailyPnl.length - 1].date).toBe(today());

        const sum = data.dailyPnl.reduce((s, d) => s + d.profit, 0);
        expect(sum).toBeCloseTo(data.totalProfit, 8);

        const first = data.dailyPnl.find((d) => d.date === snapshotDay);
        expect(first).toEqual({
            date: snapshotDay,
            profit: 13.5,
            volume: 1500,
            users: 7,
            bySource: { EXIT_FEE: 10, P2P_MARGIN: 3.5 },
        });
        const last = data.dailyPnl.find((d) => d.date === today());
        expect(last.profit).toBeCloseTo(0.03, 8);
        expect(last.bySource).toEqual({ GAS_FEE_REVENUE: 0.03, SMART_ESCROW_FEE: 0 });
        // No snapshot for the day: volume and users are unknown, not zero.
        expect(last.volume).toBeNull();
        expect(last.users).toBeNull();

        const quiet = data.dailyPnl.find((d) => d.date === daysAgo(5));
        expect(quiet).toEqual({ date: daysAgo(5), profit: 0, volume: null, users: null, bySource: {} });
    });

    test('an empty period reports zero revenue and nothing left out', async () => {
        const res = await run(makePrisma({ rows: [] }), '24h');
        const data = res.json.mock.calls[0][0].data;

        expect(data.totalProfit).toBe(0);
        expect(data.totalTransactions).toBe(0);
        expect(data.sourceBreakdown).toEqual({});
        expect(data.excluded).toEqual({ totalUsdc: 0, count: 0, items: [] });
        expect(data.reversals).toEqual({ totalUsdc: 0, count: 0 });
        expect(data.dailyPnl.every((d) => d.profit === 0)).toBe(true);
    });

    test('a failed read is a 500, not a page of zeros', async () => {
        const prisma = makePrisma();
        prisma.$queryRaw = jest.fn(async () => { throw new Error('read replica down'); });
        const res = await run(prisma);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, message: 'read replica down' });
    });

    test('the older adminController export serves the same answer', async () => {
        const prisma = makePrisma({ rows: sampleRows() });
        getReadPrisma.mockReturnValue(prisma);
        const res = makeRes();

        await adminController.getProfitBreakdown({ app: {}, query: { period: '30d' } }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json.mock.calls[0][0].data.totalProfit).toBeCloseTo(13.53, 8);
        expect(prisma.adminProfitLog.groupBy).not.toHaveBeenCalled();
    });
});
