const logger = require('../src/config/logger');
const { getReadPrisma } = require('../src/config/readReplica');
const profitRevenue = require('../services/profitRevenueService');

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every UTC day from `from` to `to`, inclusive, as YYYY-MM-DD. */
function daysBetween(from, to) {
    const out = [];
    const last = dayKey(to);
    let cursor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    for (;;) {
        const key = new Date(cursor).toISOString().slice(0, 10);
        out.push(key);
        if (key >= last) break;
        cursor += DAY_MS;
    }
    return out;
}

/**
 * GET /api/admin/profit-breakdown?period=24h|7d|30d|90d
 *
 * The dashboard's period selector is an API contract: every period changes
 * the source query, totals, chart data, and returned period metadata.
 *
 * Revenue is what Azaman keeps (services/profitRevenueService): withdrawal
 * principal, profit liquidations and referrer payouts are left out and
 * reported under `excluded`; reversals net against their source. The daily
 * profit comes from the same rows, so the chart adds up to the total. Volume
 * and active users come from the daily snapshot when one exists for the day
 * (null otherwise).
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
        const from = new Date(now.getTime() - periodDays * DAY_MS);

        const fiatPoolMode = await require('../src/services/fiatLiquidityActivationService').readModeAndPool(prisma);
        const [profitFees, hotWallet, masterCrypto, revenue, dailySnapshots] = await Promise.all([
            prisma.systemProfitFees.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemHotWallet.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            prisma.systemMasterCrypto.findUnique({ where: { id: 1 } }).catch(() => ({ balance: 0 })),
            profitRevenue.readRevenue(prisma, { from, to: now }),
            prisma.dailySnapshot.findMany({
                where: { date: { gte: from } },
                orderBy: { date: 'asc' },
                select: {
                    date: true,
                    totalVolumeUsdc: true,
                    activeUsers: true,
                },
            }),
        ]);

        const snapshotByDay = new Map(dailySnapshots.map((snapshot) => [dayKey(snapshot.date), snapshot]));
        const dailyPnl = daysBetween(from, now).map((date) => {
            const day = revenue.daily.get(date);
            const snapshot = snapshotByDay.get(date);
            return {
                date,
                profit: day ? day.profit : 0,
                volume: snapshot ? asNumber(snapshot.totalVolumeUsdc) : null,
                users: snapshot ? Number(snapshot.activeUsers || 0) : null,
                bySource: day ? day.bySource : {},
            };
        });

        return res.status(200).json({
            success: true,
            data: {
                pools: (() => {
                    // The unit of the pool figure depends on the P5-D regime.
                    const mode = fiatPoolMode;
                    return {
                    profitFees: asNumber(profitFees?.balance),
                    fiatPool: asNumber(fiatPoolMode.balance),
                    fiatPoolUnit: mode.authorityUnit,
                    fiatPoolRegime: mode.active ? 'GHS_AUTHORITY' : 'LEGACY_USDC_POOL',
                    hotWallet: asNumber(hotWallet?.balance),
                    masterCrypto: asNumber(masterCrypto?.balance),
                    };
                })(),
                sourceBreakdown: revenue.sourceBreakdown,
                dailyPnl,
                totalProfit: revenue.totalUsdc,
                totalTransactions: revenue.count,
                reversals: revenue.reversals,
                excluded: revenue.excluded,
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
