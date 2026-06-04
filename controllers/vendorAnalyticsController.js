// controllers/vendorAnalyticsController.js
// =============================================================================
// AZAMAN — VENDOR ANALYTICS CONTROLLER (Phase Q16)
//
// Endpoints:
//   GET /api/vendor/analytics?period=7d|30d|90d
//
// Returns aggregated vendor performance data:
//   - Volume over time (daily buckets)
//   - Revenue by payment method
//   - Average trade completion time
//   - Dispute rate
//   - Trade count by status
//   - Top trading days
// =============================================================================

exports.getVendorAnalytics = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const vendorId = req.user.id;
        const period = req.query.period || '30d';

        // Calculate date range
        // BUGFIX (Phase H12, 2026-05-27): off-by-one in the date-bucket
        // window. The previous code computed `startDate = today -
        // days` and then looped `for i in 0..days` to generate buckets
        // — which produced buckets for `today-days` through
        // `today-1`, EXCLUDING today. A trade completed today fell
        // outside every bucket and was silently dropped from the
        // timeline (though still counted in the totals).
        //
        // Fix: anchor the window so the LAST bucket is today. The
        // window is `today-(days-1)` through `today`, inclusive — i.e.
        // exactly `days` buckets ending today.
        const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
        const startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        startDate.setDate(startDate.getDate() - (days - 1));

        // Run all queries in parallel
        const [
            trades,
            disputeCount,
            totalTradesAllTime,
            totalDisputesAllTime,
        ] = await Promise.all([
            // All completed trades in period (for volume, timing, method breakdown)
            prisma.trade.findMany({
                where: {
                    vendorId,
                    status: 'COMPLETED',
                    completedAt: { gte: startDate },
                },
                select: {
                    id: true,
                    amountCrypto: true,
                    amountFiat: true,
                    paymentMethod: true,
                    vendorProfitCut: true,
                    tradeStartTime: true,
                    completedAt: true,
                    createdAt: true,
                },
                orderBy: { completedAt: 'asc' },
            }),

            // Disputes in period
            prisma.trade.count({
                where: {
                    vendorId,
                    status: 'DISPUTED',
                    createdAt: { gte: startDate },
                },
            }),

            // All-time trade count
            prisma.trade.count({
                where: { vendorId, status: 'COMPLETED' },
            }),

            // All-time dispute count
            prisma.trade.count({
                where: { vendorId, status: 'DISPUTED' },
            }),
        ]);

        // ── Compute Volume Over Time (daily buckets) ─────────────────────────
        const volumeByDay = {};
        for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const key = d.toISOString().split('T')[0];
            volumeByDay[key] = { date: key, volume: 0, trades: 0, revenue: 0 };
        }

        for (const trade of trades) {
            const key = new Date(trade.completedAt).toISOString().split('T')[0];
            if (volumeByDay[key]) {
                volumeByDay[key].volume += Number(trade.amountCrypto);
                volumeByDay[key].trades += 1;
                volumeByDay[key].revenue += Number(trade.vendorProfitCut || 0);
            }
        }

        const volumeTimeline = Object.values(volumeByDay);

        // ── Revenue by Payment Method ────────────────────────────────────────
        const methodBreakdown = {};
        for (const trade of trades) {
            const method = trade.paymentMethod || 'Unknown';
            if (!methodBreakdown[method]) {
                methodBreakdown[method] = { method, volume: 0, trades: 0, revenue: 0 };
            }
            methodBreakdown[method].volume += Number(trade.amountCrypto);
            methodBreakdown[method].trades += 1;
            methodBreakdown[method].revenue += Number(trade.vendorProfitCut || 0);
        }

        // ── Average Completion Time ──────────────────────────────────────────
        let avgCompletionMinutes = 0;
        if (trades.length > 0) {
            const totalMs = trades.reduce((sum, t) => {
                if (t.completedAt && t.tradeStartTime) {
                    return sum + (new Date(t.completedAt) - new Date(t.tradeStartTime));
                }
                return sum;
            }, 0);
            avgCompletionMinutes = Math.round(totalMs / trades.length / 60000 * 10) / 10;
        }

        // ── Summary Stats ────────────────────────────────────────────────────
        const totalVolume = trades.reduce((s, t) => s + Number(t.amountCrypto), 0);
        const totalRevenue = trades.reduce((s, t) => s + Number(t.vendorProfitCut || 0), 0);
        const disputeRate = totalTradesAllTime > 0
            ? Math.round((totalDisputesAllTime / totalTradesAllTime) * 10000) / 100
            : 0;

        return res.status(200).json({
            success: true,
            data: {
                period,
                days,
                summary: {
                    totalTrades: trades.length,
                    totalVolume: Math.round(totalVolume * 100) / 100,
                    totalRevenue: Math.round(totalRevenue * 100) / 100,
                    avgCompletionMinutes,
                    disputeRate,
                    disputesInPeriod: disputeCount,
                    allTimeTrades: totalTradesAllTime,
                },
                volumeTimeline,
                methodBreakdown: Object.values(methodBreakdown).sort((a, b) => b.volume - a.volume),
            },
        });

    } catch (error) {
        console.error('[vendorAnalytics] error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
    }
};
