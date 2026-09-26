const logger = require('../src/config/logger');
const { getReadPrisma } = require('../src/config/readReplica');

const PERIODS = Object.freeze({
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
});

function getPeriodDays(value) {
    return PERIODS[value] || PERIODS['30d'];
}

function asNumber(value) {
    if (value == null) return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function dayKey(value) {
    return new Date(value).toISOString().slice(0, 10);
}

/**
 * GET /api/admin/profit-breakdown?period=24h|7d|30d|90d
 *
 * The dashboard's period selector is an API contract: every period changes
 * the source query, totals, chart data, and returned period metadata.
 */
exports.getProfitBreakdown = async (req, res) => {
    const prisma = getReadPrisma(req.app);
    const requestedPeriod = typeof req.query.period === 'string' ? req.query.period : '30d';

    if (!Object.prototype.hasOwnProperty.call(PERIODS, requestedPeriod)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid profit period. Use one of: 24h, 7d, 30d, 90d.',
            allowedPeriods: Object.keys(PERIODS),
        });
    }

    try {
        const now = new Date();
        const periodDays = getPeriodDays(requestedPeriod);
        const from = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

        const [profitFees, fiatPool, hotWallet, masterCrypto, profitLogs, dailySnapshots] = await Promise.all([
            prisma.systemProfitFees.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemFiatPool.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemHotWallet.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemMasterCrypto.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.adminProfitLog.groupBy({
                by: ['source'],
                where: { createdAt: { gte: from } },
                _sum: { amountUsdc: true },
                _count: true,
            }),
            prisma.dailySnapshot.findMany({
                where: { date: { gte: from } },
                orderBy: { date: 'asc' },
                select: {
                    date: true,
                    totalProfitUsdc: true,
                    totalVolumeUsdc: true,
                    activeUsers: true,
                    profitBySource: true,
                },
            }),
        ]);

        const sourceBreakdown = {};
        let totalProfit = 0;
        let totalTransactions = 0;
        for (const log of profitLogs) {
            const totalUsdc = asNumber(log._sum?.amountUsdc);
            const count = Number(log._count || 0);
            sourceBreakdown[log.source] = { totalUsdc, count };
            totalProfit += totalUsdc;
            totalTransactions += count;
        }

        let dailyPnl = dailySnapshots.map((snapshot) => ({
            date: snapshot.date,
            profit: asNumber(snapshot.totalProfitUsdc),
            volume: asNumber(snapshot.totalVolumeUsdc),
            users: Number(snapshot.activeUsers || 0),
            bySource: snapshot.profitBySource,
        }));

        if (dailyPnl.length === 0) {
            const recentLogs = await prisma.adminProfitLog.findMany({
                where: { createdAt: { gte: from } },
                orderBy: { createdAt: 'asc' },
                select: { amountUsdc: true, source: true, createdAt: true },
            });

            const dayMap = new Map();
            for (const log of recentLogs) {
                const date = dayKey(log.createdAt);
                const entry = dayMap.get(date) || { profit: 0, count: 0 };
                entry.profit += asNumber(log.amountUsdc);
                entry.count += 1;
                dayMap.set(date, entry);
            }

            dailyPnl = [...dayMap.entries()].map(([date, data]) => ({
                date,
                profit: data.profit,
                volume: 0,
                users: 0,
            }));
        }

        return res.status(200).json({
            success: true,
            data: {
                pools: {
                    profitFees: asNumber(profitFees?.balance),
                    fiatPool: asNumber(fiatPool?.balance),
                    hotWallet: asNumber(hotWallet?.balance),
                    masterCrypto: asNumber(masterCrypto?.balance),
                },
                sourceBreakdown,
                dailyPnl,
                totalProfit,
                totalTransactions,
                period: {
                    key: requestedPeriod,
                    from: from.toISOString(),
                    to: now.toISOString(),
                },
            },
        });
    } catch (error) {
        logger.error({ err: error, period: requestedPeriod }, '[getProfitBreakdown] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};
