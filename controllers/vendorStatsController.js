// controllers/vendorStatsController.js
// =============================================================================
// AZAMAN V3 — VENDOR STATS & GAMIFICATION CONTROLLER
//
// Endpoints:
//   GET  /api/vendor/stats           — Full gamified vendor profile
//   GET  /api/vendor/achievements    — All achievements (earned + available)
//   GET  /api/vendor/leaderboard     — Weekly leaderboard for vendors
//   POST /api/vendor/xp/review       — Award/penalize XP on review received
// =============================================================================

const logger = require('../src/config/logger');
const { getReadPrisma } = require('../src/config/readReplica');
const gamification = require('../services/vendorGamificationService');

// =============================================================================
// 1. GET VENDOR STATS
//    GET /api/vendor/stats
//
//    Returns the complete gamified vendor profile including:
//    - XP, level, level progress
//    - Streak info
//    - Trade stats
//    - Volume/profit totals
//    - Achievement count
//    - Ad analytics summary
// =============================================================================
exports.getVendorStats = async (req, res) => {
    const prisma = getReadPrisma(req.app);

    try {
        const vendorId = req.user.id;

        // -------- Phase I2 (2026-05-25): parallelise vendor stats queries --------
        // Pre-Phase-I2 this endpoint did 4 sequential Prisma calls (user
        // findUnique → vendorAchievement count → ad count total → ad count
        // active → ad findMany for IDs) before the existing 3-way Promise.all
        // on adInteraction. The user lookup must come first because we need
        // the existence check, but everything that depends only on vendorId
        // can run in parallel. Saves ~3-4 round-trips per request.
        const vendor = await prisma.user.findUnique({
            where: { id: vendorId },
            select: {
                id: true,
                username: true,
                role: true,
                vendorXp: true,
                vendorLevel: true,
                currentStreak: true,
                longestStreak: true,
                lastTradeDate: true,
                totalVolumeUsdc: true,
                totalProfitUsdc: true,
                tradesCompleted: true,
                completionRate: true,
                positiveReviews: true,
                negativeReviews: true,
                kycStatus: true,
                createdAt: true
            }
        });

        if (!vendor) {
            return res.status(404).json({ success: false, message: 'Vendor not found.' });
        }

        // Parallel fan-out: 4 queries that depend only on vendorId.
        // Use ad.groupBy to collapse two ad.count calls (total + active) into one.
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [achievementCount, adStatusGroups, adIdRows] = await Promise.all([
            prisma.vendorAchievement.count({
                where: { userId: vendorId }
            }),
            prisma.ad.groupBy({
                by:    ['status'],
                where: { vendorId },
                _count: { _all: true }
            }),
            prisma.ad.findMany({
                where: { vendorId },
                select: { id: true }
            })
        ]);

        // Level progress (sync — pure function)
        const levelInfo = gamification.getNextLevelInfo(vendor.vendorLevel, vendor.vendorXp);

        const totalAchievements = gamification.ACHIEVEMENT_DEFINITIONS.length;

        // Derive total + active ad counts from the groupBy result
        let adCount = 0;
        let activeAdCount = 0;
        for (const g of adStatusGroups) {
            adCount += g._count._all;
            if (g.status === 'ACTIVE') activeAdCount = g._count._all;
        }

        const adIds = adIdRows.map(a => a.id);

        // Total interactions on vendor's ads (last 30 days) — already 3-way Promise.all
        let recentInteractions = { views: 0, tradeClicks: 0, closeAways: 0 };
        if (adIds.length > 0) {
            const [views, tradeClicks, closeAways] = await Promise.all([
                prisma.adInteraction.count({
                    where: { adId: { in: adIds }, type: 'VIEWED', createdAt: { gte: thirtyDaysAgo } }
                }),
                prisma.adInteraction.count({
                    where: { adId: { in: adIds }, type: 'TRADE_INITIATED', createdAt: { gte: thirtyDaysAgo } }
                }),
                prisma.adInteraction.count({
                    where: { adId: { in: adIds }, type: 'CLOSED', createdAt: { gte: thirtyDaysAgo } }
                })
            ]);
            recentInteractions = { views, tradeClicks, closeAways };
        }

        // Compute days since account creation
        const daysSinceCreation = Math.floor(
            (Date.now() - new Date(vendor.createdAt).getTime()) / (24 * 60 * 60 * 1000)
        );

        // Compute reputation score (0-100)
        const totalReviews = vendor.positiveReviews + vendor.negativeReviews;
        const reputationScore = totalReviews > 0
            ? parseFloat(((vendor.positiveReviews / totalReviews) * 100).toFixed(1))
            : 100; // Default perfect for new vendors

        return res.status(200).json({
            success: true,
            data: {
                profile: {
                    id: vendor.id,
                    username: vendor.username,
                    role: vendor.role,
                    kycStatus: vendor.kycStatus,
                    memberSince: vendor.createdAt,
                    daysSinceCreation
                },
                gamification: {
                    xp: vendor.vendorXp,
                    level: vendor.vendorLevel,
                    levelProgress: levelInfo,
                    streak: {
                        current: vendor.currentStreak,
                        longest: vendor.longestStreak,
                        lastTradeDate: vendor.lastTradeDate,
                        isActiveToday: _isToday(vendor.lastTradeDate)
                    }
                },
                achievements: {
                    earned: achievementCount,
                    total: totalAchievements,
                    completionPercent: parseFloat(((achievementCount / totalAchievements) * 100).toFixed(1))
                },
                trading: {
                    tradesCompleted: vendor.tradesCompleted,
                    completionRate: vendor.completionRate,
                    totalVolumeUsdc: vendor.totalVolumeUsdc,
                    totalProfitUsdc: vendor.totalProfitUsdc,
                    avgTradeSize: vendor.tradesCompleted > 0
                        ? parseFloat((vendor.totalVolumeUsdc / vendor.tradesCompleted).toFixed(2))
                        : 0
                },
                reputation: {
                    score: reputationScore,
                    positiveReviews: vendor.positiveReviews,
                    negativeReviews: vendor.negativeReviews,
                    totalReviews
                },
                ads: {
                    total: adCount,
                    active: activeAdCount,
                    recentInteractions
                }
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[vendorStats.getVendorStats] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 2. GET ACHIEVEMENTS
//    GET /api/vendor/achievements
//
//    Returns all achievement definitions with status (locked/unlocked).
// =============================================================================
exports.getAchievements = async (req, res) => {
    const prisma = getReadPrisma(req.app);

    try {
        const vendorId = req.user.id;

        // Phase I2: parallelise the two independent queries.
        // earned achievements + current stats can run concurrently.
        const [earned, vendor] = await Promise.all([
            prisma.vendorAchievement.findMany({
                where: { userId: vendorId },
                orderBy: { unlockedAt: 'desc' }
            }),
            prisma.user.findUnique({
                where: { id: vendorId },
                select: {
                    tradesCompleted: true,
                    totalVolumeUsdc: true,
                    totalProfitUsdc: true,
                    positiveReviews: true,
                    negativeReviews: true,
                    completionRate: true,
                    currentStreak: true,
                    longestStreak: true,
                    kycStatus: true
                }
            })
        ]);

        const earnedIds = new Set(earned.map(a => a.achievementId));

        // Build the complete achievement list
        const allAchievements = gamification.ACHIEVEMENT_DEFINITIONS.map(def => {
            const isUnlocked = earnedIds.has(def.id);
            const earnedEntry = earned.find(e => e.achievementId === def.id);

            return {
                id: def.id,
                name: def.name,
                description: def.description,
                iconName: def.iconName,
                tier: def.tier,
                xpReward: def.xpReward,
                unlocked: isUnlocked,
                unlockedAt: earnedEntry?.unlockedAt || null,
                // Provide progress hints for locked achievements
                progressHint: !isUnlocked ? _getProgressHint(def, vendor) : null
            };
        });

        // Separate into categories
        const categorized = {
            tradeMilestones: allAchievements.filter(a => a.id.startsWith('trades_') || a.id === 'first_trade'),
            volumeMilestones: allAchievements.filter(a => a.id.startsWith('volume_')),
            reputation: allAchievements.filter(a => a.id.startsWith('reviews_') || a.id.startsWith('completion_') || a.id === 'zero_negatives'),
            streaks: allAchievements.filter(a => a.id.startsWith('streak_')),
            special: allAchievements.filter(a => ['kyc_verified', 'profit_1k', 'profit_10k'].includes(a.id))
        };

        return res.status(200).json({
            success: true,
            data: {
                summary: {
                    total: allAchievements.length,
                    unlocked: earned.length,
                    locked: allAchievements.length - earned.length,
                    totalXpFromAchievements: earned.reduce((sum, a) => sum + a.xpAwarded, 0)
                },
                achievements: allAchievements,
                categorized,
                recentlyUnlocked: earned.slice(0, 5).map(e => ({
                    id: e.achievementId,
                    name: e.name,
                    tier: e.tier,
                    unlockedAt: e.unlockedAt
                }))
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[vendorStats.getAchievements] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 3. GET VENDOR LEADERBOARD
//    GET /api/vendor/leaderboard
//    Query: ?metric=volume|trades|xp|profit (default: xp)
//           &limit=10 (default: 20)
//
//    Returns the top vendors ranked by the selected metric.
// =============================================================================
exports.getLeaderboard = async (req, res) => {
    const prisma = getReadPrisma(req.app);

    try {
        const vendorId = req.user.id;
        const metric = req.query.metric || 'xp';
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);

        // Determine sort field
        let orderByField;
        switch (metric) {
            case 'volume':  orderByField = 'totalVolumeUsdc'; break;
            case 'trades':  orderByField = 'tradesCompleted'; break;
            case 'profit':  orderByField = 'totalProfitUsdc'; break;
            case 'streak':  orderByField = 'longestStreak'; break;
            case 'xp':
            default:        orderByField = 'vendorXp'; break;
        }

        const topVendors = await prisma.user.findMany({
            where: { role: 'VENDOR' },
            orderBy: { [orderByField]: 'desc' },
            take: limit,
            select: {
                id: true,
                username: true,
                vendorXp: true,
                vendorLevel: true,
                tradesCompleted: true,
                totalVolumeUsdc: true,
                totalProfitUsdc: true,
                currentStreak: true,
                longestStreak: true,
                completionRate: true,
                positiveReviews: true,
                kycStatus: true
            }
        });

        // Find calling vendor's rank
        // Phase I2: parallelise the rank-lookup branches with the totalVendors count.
        let myRank = null;
        const myIndex = topVendors.findIndex(v => v.id === vendorId);
        if (myIndex !== -1) {
            myRank = myIndex + 1;
        }

        // myRank fallback (when caller is below the top N) needs two queries
        // we can run in parallel — myVendor lookup and the totalVendors count
        // for the response below.
        const needsRankLookup = myIndex === -1;
        const [myVendor, totalVendors] = await Promise.all([
            needsRankLookup
                ? prisma.user.findUnique({
                    where: { id: vendorId },
                    select: { [orderByField]: true }
                  })
                : Promise.resolve(null),
            prisma.user.count({ where: { role: 'VENDOR' } })
        ]);

        if (needsRankLookup && myVendor) {
            const aboveMe = await prisma.user.count({
                where: {
                    role: 'VENDOR',
                    [orderByField]: { gt: myVendor[orderByField] }
                }
            });
            myRank = aboveMe + 1;
        }

        const leaderboard = topVendors.map((v, i) => ({
            rank: i + 1,
            id: v.id,
            username: v.username,
            level: v.vendorLevel,
            xp: v.vendorXp,
            tradesCompleted: v.tradesCompleted,
            totalVolume: v.totalVolumeUsdc,
            totalProfit: v.totalProfitUsdc,
            streak: v.currentStreak,
            longestStreak: v.longestStreak,
            completionRate: v.completionRate,
            kycVerified: v.kycStatus === 'VERIFIED',
            isYou: v.id === vendorId
        }));

        return res.status(200).json({
            success: true,
            data: {
                metric,
                myRank,
                totalVendors,
                leaderboard
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[vendorStats.getLeaderboard] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 4. AWARD XP ON REVIEW
//    POST /api/vendor/xp/review
//    Body: { vendorId, isPositive }
//
//    Called internally after a review is submitted. Awards or penalizes XP.
//    Also checks for new achievements related to reviews.
// =============================================================================
exports.awardXpForReview = async (req, res) => {
    const prisma = getReadPrisma(req.app);

    try {
        const { vendorId, isPositive } = req.body;

        if (!vendorId) {
            return res.status(400).json({ success: false, message: 'vendorId is required.' });
        }

        const xpAmount = isPositive
            ? gamification.XP_REWARDS.POSITIVE_REVIEW
            : gamification.XP_REWARDS.NEGATIVE_REVIEW;

        const result = await prisma.$transaction(async (tx) => {
            // Award XP
            const xpResult = await gamification.awardXp(tx, vendorId, xpAmount, isPositive ? 'positive_review' : 'negative_review');

            // Check achievements
            const vendor = await tx.user.findUnique({
                where: { id: vendorId },
                select: {
                    tradesCompleted: true,
                    totalVolumeUsdc: true,
                    totalProfitUsdc: true,
                    positiveReviews: true,
                    negativeReviews: true,
                    completionRate: true,
                    currentStreak: true,
                    longestStreak: true,
                    kycStatus: true
                }
            });

            const statsSnapshot = {
                tradesCompleted: vendor.tradesCompleted,
                totalVolumeUsdc: vendor.totalVolumeUsdc,
                totalProfitUsdc: vendor.totalProfitUsdc,
                positiveReviews: vendor.positiveReviews,
                negativeReviews: vendor.negativeReviews,
                completionRate: vendor.completionRate,
                currentStreak: vendor.currentStreak,
                longestStreak: vendor.longestStreak,
                kycVerified: vendor.kycStatus === 'VERIFIED'
            };

            const newAchievements = await gamification.checkAndUnlockAchievements(tx, vendorId, statsSnapshot);

            return { xpResult, newAchievements };
        });

        return res.status(200).json({
            success: true,
            message: `XP ${xpAmount >= 0 ? 'awarded' : 'penalized'}: ${xpAmount} XP`,
            data: {
                xpChange: xpAmount,
                ...result.xpResult,
                newAchievements: result.newAchievements
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[vendorStats.awardXpForReview] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 5. QUICK VENDOR STATS (Lightweight — for floating pull-tab)
//    GET /api/vendor/stats/quick
//
//    Returns minimal gamification snapshot: level, xp, streak, active trades.
//    Used by the floating "For Vendor" tab to show a teaser without loading
//    the full dashboard data.
// =============================================================================
exports.getVendorStatsQuick = async (req, res) => {
    const prisma = getReadPrisma(req.app);

    try {
        const vendorId = req.user.id;

        const vendor = await prisma.user.findUnique({
            where: { id: vendorId },
            select: {
                vendorXp: true,
                vendorLevel: true,
                currentStreak: true,
                tradesCompleted: true,
                totalProfitUsdc: true,
                lastTradeDate: true,
                role: true
            }
        });

        if (!vendor) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Phase I2: parallelise the two queries that depend only on vendorId.
        const [activeTrades, lastAchievement] = await Promise.all([
            prisma.trade.count({
                where: {
                    vendorId,
                    status: { in: ['PENDING', 'PENDING_PAYMENT', 'PAID', 'DISPUTED'] }
                }
            }),
            prisma.vendorAchievement.findFirst({
                where: { userId: vendorId },
                orderBy: { unlockedAt: 'desc' },
                select: { name: true, tier: true, iconName: true, unlockedAt: true }
            })
        ]);

        // Level progress (sync — pure function)
        const levelInfo = gamification.getNextLevelInfo(vendor.vendorLevel, vendor.vendorXp);

        return res.status(200).json({
            success: true,
            data: {
                level: vendor.vendorLevel,
                xp: vendor.vendorXp,
                levelProgress: levelInfo.progress,
                nextLevel: levelInfo.nextLevel,
                xpToNext: levelInfo.xpToNext,
                streak: vendor.currentStreak,
                isActiveToday: _isToday(vendor.lastTradeDate),
                tradesCompleted: vendor.tradesCompleted,
                totalProfit: vendor.totalProfitUsdc,
                activeTrades,
                isVendor: vendor.role === 'VENDOR',
                lastAchievement
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[vendorStats.getVendorStatsQuick] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function _isToday(date) {
    if (!date) return false;
    const d = new Date(date);
    const today = new Date();
    return d.toDateString() === today.toDateString();
}

/**
 * Generate a progress hint for a locked achievement.
 */
function _getProgressHint(def, vendor) {
    if (!vendor) return null;

    switch (true) {
        case def.id === 'first_trade':
            return `${vendor.tradesCompleted}/1 trades`;
        case def.id.startsWith('trades_'): {
            const target = parseInt(def.id.split('_')[1], 10);
            return `${vendor.tradesCompleted}/${target} trades`;
        }
        case def.id.startsWith('volume_'): {
            const targetVal = def.id === 'volume_1k' ? 1000
                : def.id === 'volume_10k' ? 10000
                : def.id === 'volume_50k' ? 50000
                : 100000;
            return `$${vendor.totalVolumeUsdc.toFixed(0)}/$${targetVal.toLocaleString()} volume`;
        }
        case def.id.startsWith('reviews_positive_'): {
            const target = parseInt(def.id.split('_')[2], 10);
            return `${vendor.positiveReviews}/${target} positive reviews`;
        }
        case def.id.startsWith('completion_rate_'): {
            const target = parseInt(def.id.split('_')[2], 10);
            return `${vendor.completionRate.toFixed(1)}%/${target}% completion rate`;
        }
        case def.id === 'zero_negatives':
            return `${vendor.negativeReviews} negative reviews (need 0 with 100+ trades)`;
        case def.id.startsWith('streak_'): {
            const target = parseInt(def.id.split('_')[1], 10);
            const best = Math.max(vendor.currentStreak, vendor.longestStreak);
            return `${best}/${target} day streak`;
        }
        case def.id === 'kyc_verified':
            return vendor.kycStatus === 'VERIFIED' ? 'Verifying...' : 'Complete KYC verification';
        case def.id.startsWith('profit_'): {
            const targetVal = def.id === 'profit_1k' ? 1000 : 10000;
            return `$${vendor.totalProfitUsdc.toFixed(0)}/$${targetVal.toLocaleString()} profit`;
        }
        default:
            return null;
    }
}
