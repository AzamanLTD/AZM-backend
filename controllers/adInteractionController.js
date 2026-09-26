// controllers/adInteractionController.js
// =============================================================================
// AZAMAN V3 — AD INTERACTION ANALYTICS CONTROLLER
//
// Tracks every user interaction with vendor ads for analytics metrics.
// Three interaction types:
//   VIEWED          — user flipped/opened the ad card to see full details
//   TRADE_INITIATED — user clicked "Start Trade" from the ad detail view
//   CLOSED          — user swiped away / dismissed the ad without trading
//
const logger = require('../src/config/logger');
// Endpoints:
//   POST /api/ads/:id/interaction       — log a single interaction
//   GET  /api/ads/:id/analytics         — vendor: get analytics for one ad
//   GET  /api/ads/analytics/overview    — vendor: aggregated stats across all ads
//   GET  /api/ads/analytics/timeline    — vendor: daily interaction timeline
// =============================================================================

const VALID_TYPES = ['VIEWED', 'TRADE_INITIATED', 'CLOSED'];

// =============================================================================
// 1. LOG AD INTERACTION
//    POST /api/ads/:id/interaction
//    Body: { type: 'VIEWED' | 'TRADE_INITIATED' | 'CLOSED', metadata?: {} }
//
//    Records the interaction. Prevents duplicate VIEWED entries within a
//    5-second window (debounce) to avoid accidental double-fires.
// =============================================================================
exports.logInteraction = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const adId = parseInt(req.params.id, 10);
        const userId = req.user.id;
        const { type, metadata } = req.body;

        // Validation
        if (!adId || isNaN(adId)) {
            return res.status(400).json({ success: false, message: 'Invalid ad ID.' });
        }
        if (!type || !VALID_TYPES.includes(type)) {
            return res.status(400).json({
                success: false,
                message: `Invalid interaction type. Must be one of: ${VALID_TYPES.join(', ')}`
            });
        }

        // Verify ad exists
        const ad = await prisma.ad.findUnique({
            where: { id: adId },
            select: { id: true, vendorId: true }
        });
        if (!ad) {
            return res.status(404).json({ success: false, message: 'Ad not found.' });
        }

        // Don't track vendor's own interactions with their ads
        if (ad.vendorId === userId) {
            return res.status(200).json({
                success: true,
                message: 'Own ad interaction — not tracked.',
                interaction: null
            });
        }

        // Debounce: prevent duplicate VIEWED within 5 seconds
        if (type === 'VIEWED') {
            const fiveSecondsAgo = new Date(Date.now() - 5000);
            const recentView = await prisma.adInteraction.findFirst({
                where: {
                    adId,
                    userId,
                    type: 'VIEWED',
                    createdAt: { gte: fiveSecondsAgo }
                }
            });
            if (recentView) {
                return res.status(200).json({
                    success: true,
                    message: 'Duplicate view debounced.',
                    interaction: recentView
                });
            }
        }

        // Create the interaction record
        const interaction = await prisma.adInteraction.create({
            data: {
                adId,
                userId,
                type,
                metadata: metadata || null
            }
        });

        // ── Real-time: Emit to vendor's room so their dashboard updates live ──
        const io = req.app.get('socketio');
        if (io) {
            io.to(`user_${ad.vendorId}`).emit('ad_interaction_update', {
                adId,
                type,
                interactionId: interaction.id,
                timestamp: interaction.createdAt,
                userId // anonymized on client — vendor sees count, not who
            });
        }

        return res.status(201).json({
            success: true,
            message: `Interaction logged: ${type}`,
            interaction
        });

    } catch (error) {
        logger.error({ err: error }, '[adInteraction.logInteraction] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 2. GET AD ANALYTICS (Single Ad)
//    GET /api/ads/:id/analytics
//    Query params: ?period=7d|30d|90d|all (default: 30d)
//
//    Returns metrics for a specific ad owned by the authenticated vendor.
// =============================================================================
exports.getAdAnalytics = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const adId = parseInt(req.params.id, 10);
        const vendorId = req.user.id;
        const period = req.query.period || '30d';

        if (!adId || isNaN(adId)) {
            return res.status(400).json({ success: false, message: 'Invalid ad ID.' });
        }

        // Verify ownership
        const ad = await prisma.ad.findUnique({
            where: { id: adId },
            select: { id: true, vendorId: true, type: true, crypto: true, status: true, createdAt: true }
        });
        if (!ad) {
            return res.status(404).json({ success: false, message: 'Ad not found.' });
        }
        if (ad.vendorId !== vendorId) {
            return res.status(403).json({ success: false, message: 'You can only view analytics for your own ads.' });
        }

        // Calculate date filter
        const dateFilter = _getDateFilter(period);

        // Count interactions by type
        const [totalViews, tradeClicks, closeAways] = await Promise.all([
            prisma.adInteraction.count({
                where: { adId, type: 'VIEWED', ...(dateFilter && { createdAt: { gte: dateFilter } }) }
            }),
            prisma.adInteraction.count({
                where: { adId, type: 'TRADE_INITIATED', ...(dateFilter && { createdAt: { gte: dateFilter } }) }
            }),
            prisma.adInteraction.count({
                where: { adId, type: 'CLOSED', ...(dateFilter && { createdAt: { gte: dateFilter } }) }
            })
        ]);

        // Unique viewers
        const uniqueViewers = await prisma.adInteraction.groupBy({
            by: ['userId'],
            where: { adId, type: 'VIEWED', ...(dateFilter && { createdAt: { gte: dateFilter } }) }
        });

        // Conversion rate
        const conversionRate = totalViews > 0
            ? parseFloat(((tradeClicks / totalViews) * 100).toFixed(2))
            : 0;

        // Bounce rate (closed without trading / total views)
        const bounceRate = totalViews > 0
            ? parseFloat(((closeAways / totalViews) * 100).toFixed(2))
            : 0;

        // Recent interactions (last 10)
        const recentInteractions = await prisma.adInteraction.findMany({
            where: { adId, ...(dateFilter && { createdAt: { gte: dateFilter } }) },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
                id: true,
                type: true,
                createdAt: true,
                user: { select: { id: true, username: true } }
            }
        });

        return res.status(200).json({
            success: true,
            data: {
                adId,
                adType: ad.type,
                adCrypto: ad.crypto,
                adStatus: ad.status,
                period,
                metrics: {
                    totalViews,
                    tradeClicks,
                    closeAways,
                    uniqueViewers: uniqueViewers.length,
                    conversionRate,
                    bounceRate,
                    engagementScore: _calculateEngagementScore(totalViews, tradeClicks, closeAways)
                },
                recentInteractions
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[adInteraction.getAdAnalytics] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 3. VENDOR ANALYTICS OVERVIEW
//    GET /api/ads/analytics/overview
//    Query params: ?period=7d|30d|90d|all (default: 30d)
//
//    Aggregated analytics across ALL of a vendor's ads.
// =============================================================================
exports.getVendorAnalyticsOverview = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const vendorId = req.user.id;
        const period = req.query.period || '30d';
        const dateFilter = _getDateFilter(period);

        // Get all vendor's ad IDs
        const vendorAds = await prisma.ad.findMany({
            where: { vendorId },
            select: { id: true, type: true, status: true, createdAt: true }
        });

        if (vendorAds.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    totalAds: 0,
                    activeAds: 0,
                    period,
                    metrics: {
                        totalViews: 0,
                        tradeClicks: 0,
                        closeAways: 0,
                        uniqueViewers: 0,
                        conversionRate: 0,
                        bounceRate: 0,
                        engagementScore: 0
                    },
                    topPerformingAds: [],
                    dailyBreakdown: []
                }
            });
        }

        const adIds = vendorAds.map(a => a.id);
        const baseWhere = { adId: { in: adIds }, ...(dateFilter && { createdAt: { gte: dateFilter } }) };

        // Aggregate counts
        const [totalViews, tradeClicks, closeAways] = await Promise.all([
            prisma.adInteraction.count({ where: { ...baseWhere, type: 'VIEWED' } }),
            prisma.adInteraction.count({ where: { ...baseWhere, type: 'TRADE_INITIATED' } }),
            prisma.adInteraction.count({ where: { ...baseWhere, type: 'CLOSED' } })
        ]);

        // Unique viewers
        const uniqueViewers = await prisma.adInteraction.groupBy({
            by: ['userId'],
            where: { ...baseWhere, type: 'VIEWED' }
        });

        const conversionRate = totalViews > 0
            ? parseFloat(((tradeClicks / totalViews) * 100).toFixed(2))
            : 0;

        const bounceRate = totalViews > 0
            ? parseFloat(((closeAways / totalViews) * 100).toFixed(2))
            : 0;

        // Top performing ads (by views)
        const adInteractionCounts = await prisma.adInteraction.groupBy({
            by: ['adId'],
            where: { ...baseWhere, type: 'VIEWED' },
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: 5
        });

        const topPerformingAds = await Promise.all(
            adInteractionCounts.map(async (entry) => {
                const adViews = entry._count.id;
                const adTradeClicks = await prisma.adInteraction.count({
                    where: { adId: entry.adId, type: 'TRADE_INITIATED', ...(dateFilter && { createdAt: { gte: dateFilter } }) }
                });
                const ad = vendorAds.find(a => a.id === entry.adId);
                return {
                    adId: entry.adId,
                    adType: ad?.type || 'SELL',
                    adStatus: ad?.status || 'ACTIVE',
                    views: adViews,
                    tradeClicks: adTradeClicks,
                    conversionRate: adViews > 0 ? parseFloat(((adTradeClicks / adViews) * 100).toFixed(2)) : 0
                };
            })
        );

        // Daily breakdown (last 7 days minimum)
        const dailyBreakdown = await _getDailyBreakdown(prisma, adIds, 7);

        return res.status(200).json({
            success: true,
            data: {
                totalAds: vendorAds.length,
                activeAds: vendorAds.filter(a => a.status === 'ACTIVE').length,
                period,
                metrics: {
                    totalViews,
                    tradeClicks,
                    closeAways,
                    uniqueViewers: uniqueViewers.length,
                    conversionRate,
                    bounceRate,
                    engagementScore: _calculateEngagementScore(totalViews, tradeClicks, closeAways)
                },
                topPerformingAds,
                dailyBreakdown
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[adInteraction.getVendorAnalyticsOverview] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 4. VENDOR ANALYTICS TIMELINE
//    GET /api/ads/analytics/timeline
//    Query params: ?days=7|14|30 (default: 14)
//
//    Returns day-by-day interaction counts for charting on the frontend.
// =============================================================================
exports.getAnalyticsTimeline = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const vendorId = req.user.id;
        const days = parseInt(req.query.days || '14', 10);

        // Get all vendor's ad IDs
        const vendorAds = await prisma.ad.findMany({
            where: { vendorId },
            select: { id: true }
        });

        if (vendorAds.length === 0) {
            return res.status(200).json({ success: true, data: { timeline: [] } });
        }

        const adIds = vendorAds.map(a => a.id);
        const timeline = await _getDailyBreakdown(prisma, adIds, days);

        return res.status(200).json({
            success: true,
            data: { timeline, days }
        });

    } catch (error) {
        logger.error({ err: error }, '[adInteraction.getAnalyticsTimeline] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 5. AD SUMMARY (Lightweight — for card flip popup)
//    GET /api/ads/:id/summary
//    
//    Returns just the 3 core metrics for display on the ad detail popup.
//    Public to the ad's vendor only (ownership check).
//    If called by a non-owner, returns the ad's public interaction totals.
// =============================================================================
exports.getAdSummary = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const adId = parseInt(req.params.id, 10);

        if (!adId || isNaN(adId)) {
            return res.status(400).json({ success: false, message: 'Invalid ad ID.' });
        }

        // Verify ad exists
        const ad = await prisma.ad.findUnique({
            where: { id: adId },
            select: { id: true, vendorId: true, type: true, crypto: true, status: true }
        });
        if (!ad) {
            return res.status(404).json({ success: false, message: 'Ad not found.' });
        }

        // Count interactions (all-time for the summary card)
        const [views, tradeInitiations, closeAways] = await Promise.all([
            prisma.adInteraction.count({ where: { adId, type: 'VIEWED' } }),
            prisma.adInteraction.count({ where: { adId, type: 'TRADE_INITIATED' } }),
            prisma.adInteraction.count({ where: { adId, type: 'CLOSED' } })
        ]);

        const conversionRate = views > 0
            ? parseFloat(((tradeInitiations / views) * 100).toFixed(1))
            : 0;

        const bounceRate = views > 0
            ? parseFloat(((closeAways / views) * 100).toFixed(1))
            : 0;

        return res.status(200).json({
            success: true,
            data: {
                adId,
                adType: ad.type,
                adCrypto: ad.crypto,
                adStatus: ad.status,
                isOwner: req.user ? ad.vendorId === req.user.id : false,
                metrics: {
                    views,
                    tradeInitiations,
                    closeAways,
                    conversionRate,
                    bounceRate
                }
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[adInteraction.getAdSummary] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 6. VENDOR ANALYTICS QUICK (for floating pull-tab preview)
//    GET /api/ads/analytics/quick
//
//    Super-lightweight: returns totals for last 24h + 7d for vendor's ads.
//    Used by the floating "For Vendor" pull-tab to show a teaser.
// =============================================================================
exports.getVendorAnalyticsQuick = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const vendorId = req.user.id;

        // Get all vendor's ad IDs
        const vendorAds = await prisma.ad.findMany({
            where: { vendorId },
            select: { id: true }
        });

        if (vendorAds.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    last24h: { views: 0, tradeClicks: 0, closeAways: 0 },
                    last7d: { views: 0, tradeClicks: 0, closeAways: 0 },
                    activeAds: 0
                }
            });
        }

        const adIds = vendorAds.map(a => a.id);
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // 24h metrics
        const [views24h, trades24h, closes24h] = await Promise.all([
            prisma.adInteraction.count({ where: { adId: { in: adIds }, type: 'VIEWED', createdAt: { gte: twentyFourHoursAgo } } }),
            prisma.adInteraction.count({ where: { adId: { in: adIds }, type: 'TRADE_INITIATED', createdAt: { gte: twentyFourHoursAgo } } }),
            prisma.adInteraction.count({ where: { adId: { in: adIds }, type: 'CLOSED', createdAt: { gte: twentyFourHoursAgo } } })
        ]);

        // 7d metrics
        const [views7d, trades7d, closes7d] = await Promise.all([
            prisma.adInteraction.count({ where: { adId: { in: adIds }, type: 'VIEWED', createdAt: { gte: sevenDaysAgo } } }),
            prisma.adInteraction.count({ where: { adId: { in: adIds }, type: 'TRADE_INITIATED', createdAt: { gte: sevenDaysAgo } } }),
            prisma.adInteraction.count({ where: { adId: { in: adIds }, type: 'CLOSED', createdAt: { gte: sevenDaysAgo } } })
        ]);

        // Active ad count
        const activeAds = await prisma.ad.count({
            where: { vendorId, status: 'ACTIVE' }
        });

        return res.status(200).json({
            success: true,
            data: {
                last24h: { views: views24h, tradeClicks: trades24h, closeAways: closes24h },
                last7d: { views: views7d, tradeClicks: trades7d, closeAways: closes7d },
                activeAds
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[adInteraction.getVendorAnalyticsQuick] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Convert a period string to a Date object for the gte filter.
 * @param {string} period - '7d', '30d', '90d', 'all'
 * @returns {Date|null}
 */
function _getDateFilter(period) {
    const now = new Date();
    switch (period) {
        case '7d':  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        case '90d': return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        case 'all': return null;
        default:    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
}

/**
 * Calculate an engagement score (0-100) based on interaction patterns.
 * Higher score = more users converting to trades.
 */
function _calculateEngagementScore(views, tradeClicks, closeAways) {
    if (views === 0) return 0;

    // Weight: trade clicks are 3x more valuable than views, close-aways are negative
    const rawScore = ((tradeClicks * 3) + views - (closeAways * 0.5)) / (views * 3) * 100;
    return Math.min(100, Math.max(0, parseFloat(rawScore.toFixed(1))));
}

/**
 * Get daily interaction breakdown for the past N days.
 */
async function _getDailyBreakdown(prisma, adIds, days) {
    const results = [];
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const dayStart = new Date(now);
        dayStart.setDate(dayStart.getDate() - i);
        dayStart.setHours(0, 0, 0, 0);

        const dayEnd = new Date(dayStart);
        dayEnd.setHours(23, 59, 59, 999);

        const baseWhere = {
            adId: { in: adIds },
            createdAt: { gte: dayStart, lte: dayEnd }
        };

        const [views, trades, closes] = await Promise.all([
            prisma.adInteraction.count({ where: { ...baseWhere, type: 'VIEWED' } }),
            prisma.adInteraction.count({ where: { ...baseWhere, type: 'TRADE_INITIATED' } }),
            prisma.adInteraction.count({ where: { ...baseWhere, type: 'CLOSED' } })
        ]);

        results.push({
            date: dayStart.toISOString().split('T')[0],
            views,
            tradeClicks: trades,
            closeAways: closes,
            total: views + trades + closes
        });
    }

    return results;
}
