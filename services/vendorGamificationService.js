// services/vendorGamificationService.js
// =============================================================================
// AZAMAN V3 — VENDOR GAMIFICATION ENGINE
//
// Core XP + Level + Streak + Achievement system for vendors.
// Consumed by vendorStatsController.js and integrated into p2p.service.js
// on trade completion.
//
// LEVEL THRESHOLDS:
//   BRONZE   →  0 – 499 XP
//   SILVER   →  500 – 1,999 XP
//   GOLD     →  2,000 – 4,999 XP
//   DIAMOND  →  5,000 – 14,999 XP
//   LEGEND   →  15,000+ XP
//
// XP REWARDS:
//   Trade completed           → +50 XP
//   Positive review received  → +20 XP
//   Achievement unlocked      → +100 XP (varies by tier)
//   Daily streak maintained   → +10 XP per day
//   Volume milestone hit      → +200 XP
//
// ACHIEVEMENTS (defined in ACHIEVEMENT_DEFINITIONS):
//   Each has: id, name, description, iconName, tier, xpReward, condition function
// =============================================================================

// ── Level Thresholds ─────────────────────────────────────────────────────────
const LEVEL_THRESHOLDS = {
    BRONZE:  0,
    SILVER:  500,
    GOLD:    2000,
    DIAMOND: 5000,
    LEGEND:  15000
};

// ── XP Reward Constants ──────────────────────────────────────────────────────
const XP_REWARDS = {
    TRADE_COMPLETED:      50,
    POSITIVE_REVIEW:      20,
    NEGATIVE_REVIEW:      -10,   // Penalty for negative reviews
    STREAK_DAY:           10,
    ACHIEVEMENT_COMMON:   50,
    ACHIEVEMENT_RARE:     100,
    ACHIEVEMENT_EPIC:     200,
    ACHIEVEMENT_LEGENDARY: 500,
    VOLUME_MILESTONE:     200,
    FIRST_TRADE:          100,
    PERFECT_WEEK:         150     // 7 days streak bonus
};

// ── Achievement Definitions ──────────────────────────────────────────────────
const ACHIEVEMENT_DEFINITIONS = [
    // === TRADE MILESTONES ===
    {
        id: 'first_trade',
        name: 'First Blood',
        description: 'Complete your very first trade as a vendor.',
        iconName: 'rocket_launch',
        tier: 'COMMON',
        xpReward: XP_REWARDS.ACHIEVEMENT_COMMON,
        check: (stats) => stats.tradesCompleted >= 1
    },
    {
        id: 'trades_10',
        name: 'Getting Started',
        description: 'Complete 10 trades as a vendor.',
        iconName: 'trending_up',
        tier: 'COMMON',
        xpReward: XP_REWARDS.ACHIEVEMENT_COMMON,
        check: (stats) => stats.tradesCompleted >= 10
    },
    {
        id: 'trades_50',
        name: 'Trusted Dealer',
        description: 'Complete 50 trades — buyers are starting to trust you.',
        iconName: 'verified',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.tradesCompleted >= 50
    },
    {
        id: 'trades_100',
        name: 'Century Club',
        description: 'Complete 100 trades. You are a market force.',
        iconName: 'military_tech',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.tradesCompleted >= 100
    },
    {
        id: 'trades_500',
        name: 'Market Titan',
        description: 'Complete 500 trades. Legendary vendor status.',
        iconName: 'workspace_premium',
        tier: 'EPIC',
        xpReward: XP_REWARDS.ACHIEVEMENT_EPIC,
        check: (stats) => stats.tradesCompleted >= 500
    },
    {
        id: 'trades_1000',
        name: 'The Thousand',
        description: '1,000 trades completed. You are the backbone of Azaman.',
        iconName: 'diamond',
        tier: 'LEGENDARY',
        xpReward: XP_REWARDS.ACHIEVEMENT_LEGENDARY,
        check: (stats) => stats.tradesCompleted >= 1000
    },

    // === VOLUME MILESTONES ===
    {
        id: 'volume_1k',
        name: 'First Thousand',
        description: 'Process $1,000 in total trading volume.',
        iconName: 'attach_money',
        tier: 'COMMON',
        xpReward: XP_REWARDS.ACHIEVEMENT_COMMON,
        check: (stats) => stats.totalVolumeUsdc >= 1000
    },
    {
        id: 'volume_10k',
        name: 'Five Figure Flow',
        description: 'Process $10,000 in total trading volume.',
        iconName: 'payments',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.totalVolumeUsdc >= 10000
    },
    {
        id: 'volume_50k',
        name: 'Big Money Mover',
        description: 'Process $50,000 in total trading volume.',
        iconName: 'account_balance',
        tier: 'EPIC',
        xpReward: XP_REWARDS.ACHIEVEMENT_EPIC,
        check: (stats) => stats.totalVolumeUsdc >= 50000
    },
    {
        id: 'volume_100k',
        name: 'Six Figure Sovereign',
        description: 'Process $100,000+ in total trading volume. True whale.',
        iconName: 'currency_exchange',
        tier: 'LEGENDARY',
        xpReward: XP_REWARDS.ACHIEVEMENT_LEGENDARY,
        check: (stats) => stats.totalVolumeUsdc >= 100000
    },

    // === REPUTATION MILESTONES ===
    {
        id: 'reviews_positive_10',
        name: 'Crowd Favorite',
        description: 'Receive 10 positive reviews from buyers.',
        iconName: 'thumb_up',
        tier: 'COMMON',
        xpReward: XP_REWARDS.ACHIEVEMENT_COMMON,
        check: (stats) => stats.positiveReviews >= 10
    },
    {
        id: 'reviews_positive_50',
        name: 'Five Star Vendor',
        description: 'Receive 50 positive reviews. Buyers love trading with you.',
        iconName: 'stars',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.positiveReviews >= 50
    },
    {
        id: 'completion_rate_95',
        name: 'Reliability King',
        description: 'Maintain a 95%+ completion rate over 20+ trades.',
        iconName: 'shield',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.completionRate >= 95 && stats.tradesCompleted >= 20
    },
    {
        id: 'completion_rate_99',
        name: 'Near Perfect',
        description: 'Maintain 99%+ completion rate over 50+ trades. Almost flawless.',
        iconName: 'verified_user',
        tier: 'EPIC',
        xpReward: XP_REWARDS.ACHIEVEMENT_EPIC,
        check: (stats) => stats.completionRate >= 99 && stats.tradesCompleted >= 50
    },
    {
        id: 'zero_negatives',
        name: 'Untouchable',
        description: 'Complete 100+ trades with zero negative reviews.',
        iconName: 'security',
        tier: 'LEGENDARY',
        xpReward: XP_REWARDS.ACHIEVEMENT_LEGENDARY,
        check: (stats) => stats.negativeReviews === 0 && stats.tradesCompleted >= 100
    },

    // === STREAK MILESTONES ===
    {
        id: 'streak_7',
        name: 'Week Warrior',
        description: 'Maintain a 7-day active trading streak.',
        iconName: 'local_fire_department',
        tier: 'COMMON',
        xpReward: XP_REWARDS.ACHIEVEMENT_COMMON,
        check: (stats) => stats.currentStreak >= 7 || stats.longestStreak >= 7
    },
    {
        id: 'streak_30',
        name: 'Monthly Machine',
        description: 'Maintain a 30-day active trading streak. Unstoppable.',
        iconName: 'whatshot',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.currentStreak >= 30 || stats.longestStreak >= 30
    },
    {
        id: 'streak_90',
        name: 'Quarterly Legend',
        description: '90-day unbroken streak. You are a force of nature.',
        iconName: 'bolt',
        tier: 'EPIC',
        xpReward: XP_REWARDS.ACHIEVEMENT_EPIC,
        check: (stats) => stats.currentStreak >= 90 || stats.longestStreak >= 90
    },

    // === SPECIAL ACHIEVEMENTS ===
    {
        id: 'kyc_verified',
        name: 'Identity Confirmed',
        description: 'Complete KYC verification for enhanced trust.',
        iconName: 'badge',
        tier: 'COMMON',
        xpReward: XP_REWARDS.ACHIEVEMENT_COMMON,
        check: (stats) => stats.kycVerified === true
    },
    {
        id: 'profit_1k',
        name: 'First Grand',
        description: 'Earn $1,000 in total vendor profits.',
        iconName: 'savings',
        tier: 'RARE',
        xpReward: XP_REWARDS.ACHIEVEMENT_RARE,
        check: (stats) => stats.totalProfitUsdc >= 1000
    },
    {
        id: 'profit_10k',
        name: 'Profit Machine',
        description: 'Earn $10,000 in total vendor profits. You are the system.',
        iconName: 'monetization_on',
        tier: 'LEGENDARY',
        xpReward: XP_REWARDS.ACHIEVEMENT_LEGENDARY,
        check: (stats) => stats.totalProfitUsdc >= 10000
    }
];

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Determine the vendor level based on current XP.
 * @param {number} xp
 * @returns {string} VendorLevel enum value
 */
function calculateLevel(xp) {
    if (xp >= LEVEL_THRESHOLDS.LEGEND)  return 'LEGEND';
    if (xp >= LEVEL_THRESHOLDS.DIAMOND) return 'DIAMOND';
    if (xp >= LEVEL_THRESHOLDS.GOLD)    return 'GOLD';
    if (xp >= LEVEL_THRESHOLDS.SILVER)  return 'SILVER';
    return 'BRONZE';
}

/**
 * Get the XP required to reach the next level.
 * @param {string} currentLevel
 * @returns {{ nextLevel: string|null, xpRequired: number, currentThreshold: number }}
 */
function getNextLevelInfo(currentLevel, currentXp) {
    const levels = ['BRONZE', 'SILVER', 'GOLD', 'DIAMOND', 'LEGEND'];
    const idx = levels.indexOf(currentLevel);

    if (idx === levels.length - 1) {
        // Already at max
        return {
            nextLevel: null,
            xpRequired: 0,
            xpToNext: 0,
            currentThreshold: LEVEL_THRESHOLDS[currentLevel],
            progress: 1.0
        };
    }

    const nextLevel = levels[idx + 1];
    const nextThreshold = LEVEL_THRESHOLDS[nextLevel];
    const currentThreshold = LEVEL_THRESHOLDS[currentLevel];
    const xpToNext = nextThreshold - currentXp;
    const rangeTotal = nextThreshold - currentThreshold;
    const rangeProgress = currentXp - currentThreshold;
    const progress = rangeTotal > 0 ? parseFloat((rangeProgress / rangeTotal).toFixed(4)) : 0;

    return {
        nextLevel,
        xpRequired: nextThreshold,
        xpToNext: Math.max(0, xpToNext),
        currentThreshold,
        progress: Math.min(1.0, Math.max(0, progress))
    };
}

/**
 * Update the vendor's streak based on trade date.
 * Call this after every completed trade.
 *
 * @param {object} tx - Prisma transaction client
 * @param {number} vendorId
 * @returns {Promise<{ currentStreak, longestStreak, streakXpAwarded }>}
 */
async function updateStreak(tx, vendorId) {
    const vendor = await tx.user.findUnique({
        where: { id: vendorId },
        select: { currentStreak: true, longestStreak: true, lastTradeDate: true }
    });

    if (!vendor) return { currentStreak: 0, longestStreak: 0, streakXpAwarded: 0 };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastDate = vendor.lastTradeDate ? new Date(vendor.lastTradeDate) : null;
    let newStreak = vendor.currentStreak;
    let streakXpAwarded = 0;

    if (lastDate) {
        lastDate.setHours(0, 0, 0, 0);
        const diffDays = Math.floor((today - lastDate) / (24 * 60 * 60 * 1000));

        if (diffDays === 0) {
            // Same day — no streak change
        } else if (diffDays === 1) {
            // Consecutive day — increment streak
            newStreak += 1;
            streakXpAwarded = XP_REWARDS.STREAK_DAY;

            // Perfect week bonus
            if (newStreak % 7 === 0) {
                streakXpAwarded += XP_REWARDS.PERFECT_WEEK;
            }
        } else {
            // Streak broken — reset to 1
            newStreak = 1;
        }
    } else {
        // First ever trade
        newStreak = 1;
    }

    const newLongest = Math.max(newStreak, vendor.longestStreak);

    await tx.user.update({
        where: { id: vendorId },
        data: {
            currentStreak: newStreak,
            longestStreak: newLongest,
            lastTradeDate: today
        }
    });

    return {
        currentStreak: newStreak,
        longestStreak: newLongest,
        streakXpAwarded
    };
}

/**
 * Award XP to a vendor and handle level-up if needed.
 * Returns the new state after XP award.
 *
 * @param {object} tx - Prisma transaction client
 * @param {number} vendorId
 * @param {number} xpAmount - Can be negative for penalties
 * @param {string} source - Description of why XP was awarded
 * @returns {Promise<{ newXp, newLevel, leveledUp, previousLevel }>}
 */
async function awardXp(tx, vendorId, xpAmount, source) {
    const vendor = await tx.user.findUnique({
        where: { id: vendorId },
        select: { vendorXp: true, vendorLevel: true }
    });

    if (!vendor) return { newXp: 0, newLevel: 'BRONZE', leveledUp: false, previousLevel: 'BRONZE' };

    const previousLevel = vendor.vendorLevel;
    const newXp = Math.max(0, vendor.vendorXp + xpAmount); // Never go below 0
    const newLevel = calculateLevel(newXp);
    const leveledUp = newLevel !== previousLevel &&
        Object.keys(LEVEL_THRESHOLDS).indexOf(newLevel) > Object.keys(LEVEL_THRESHOLDS).indexOf(previousLevel);

    await tx.user.update({
        where: { id: vendorId },
        data: {
            vendorXp: newXp,
            vendorLevel: newLevel
        }
    });

    return { newXp, newLevel, leveledUp, previousLevel };
}

/**
 * Check and unlock any newly earned achievements.
 * Called after stats change (trade completion, review, streak update).
 *
 * @param {object} tx - Prisma transaction client
 * @param {number} vendorId
 * @param {object} stats - Current vendor stats snapshot
 * @returns {Promise<Array<{ achievementId, name, tier, xpReward }>>}
 */
async function checkAndUnlockAchievements(tx, vendorId, stats) {
    // Get already unlocked achievements
    const existing = await tx.vendorAchievement.findMany({
        where: { userId: vendorId },
        select: { achievementId: true }
    });
    const unlockedIds = new Set(existing.map(a => a.achievementId));

    const newlyUnlocked = [];

    for (const achievement of ACHIEVEMENT_DEFINITIONS) {
        if (unlockedIds.has(achievement.id)) continue; // Already has it

        if (achievement.check(stats)) {
            // Unlock the achievement
            await tx.vendorAchievement.create({
                data: {
                    userId: vendorId,
                    achievementId: achievement.id,
                    name: achievement.name,
                    description: achievement.description,
                    iconName: achievement.iconName,
                    xpAwarded: achievement.xpReward,
                    tier: achievement.tier
                }
            });

            // Award the XP for this achievement
            await tx.user.update({
                where: { id: vendorId },
                data: { vendorXp: { increment: achievement.xpReward } }
            });

            newlyUnlocked.push({
                achievementId: achievement.id,
                name: achievement.name,
                description: achievement.description,
                iconName: achievement.iconName,
                tier: achievement.tier,
                xpReward: achievement.xpReward
            });
        }
    }

    return newlyUnlocked;
}

/**
 * Full post-trade gamification update.
 * Called inside the p2p.service.completeTrade transaction.
 *
 * Updates: XP, streak, volume, profit, level, achievements.
 *
 * @param {object} tx - Prisma transaction client
 * @param {number} vendorId
 * @param {number} tradeVolumeUsdc - The amountCrypto of the completed trade
 * @param {number} vendorProfitUsdc - The vendor's profit cut from the trade
 * @returns {Promise<object>} - Summary of all gamification changes
 */
async function processTradeCompletion(tx, vendorId, tradeVolumeUsdc, vendorProfitUsdc) {
    // 1. Update volume and profit trackers
    await tx.user.update({
        where: { id: vendorId },
        data: {
            totalVolumeUsdc: { increment: tradeVolumeUsdc },
            totalProfitUsdc: { increment: vendorProfitUsdc }
        }
    });

    // 2. Update streak
    const streakResult = await updateStreak(tx, vendorId);

    // 3. Award base trade XP + streak XP
    const totalXpForTrade = XP_REWARDS.TRADE_COMPLETED + streakResult.streakXpAwarded;
    const xpResult = await awardXp(tx, vendorId, totalXpForTrade, 'trade_completed');

    // 4. Get fresh stats for achievement checking
    const freshVendor = await tx.user.findUnique({
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
        tradesCompleted: freshVendor.tradesCompleted,
        totalVolumeUsdc: freshVendor.totalVolumeUsdc,
        totalProfitUsdc: freshVendor.totalProfitUsdc,
        positiveReviews: freshVendor.positiveReviews,
        negativeReviews: freshVendor.negativeReviews,
        completionRate: freshVendor.completionRate,
        currentStreak: freshVendor.currentStreak,
        longestStreak: freshVendor.longestStreak,
        kycVerified: freshVendor.kycStatus === 'VERIFIED'
    };

    // 5. Check and unlock achievements
    const newAchievements = await checkAndUnlockAchievements(tx, vendorId, statsSnapshot);

    // 6. Recalculate level (achievements may have added more XP)
    const finalVendor = await tx.user.findUnique({
        where: { id: vendorId },
        select: { vendorXp: true, vendorLevel: true }
    });

    const finalLevel = calculateLevel(finalVendor.vendorXp);
    if (finalLevel !== finalVendor.vendorLevel) {
        await tx.user.update({
            where: { id: vendorId },
            data: { vendorLevel: finalLevel }
        });
    }

    return {
        xpAwarded: totalXpForTrade,
        xpFromAchievements: newAchievements.reduce((sum, a) => sum + a.xpReward, 0),
        totalXpGained: totalXpForTrade + newAchievements.reduce((sum, a) => sum + a.xpReward, 0),
        newXpTotal: finalVendor.vendorXp,
        level: finalLevel,
        leveledUp: xpResult.leveledUp,
        previousLevel: xpResult.previousLevel,
        streak: streakResult,
        newAchievements
    };
}

// =============================================================================
// REVIEW GAMIFICATION (Phase I4 — 2026-05-25)
//
// Vendor-only XP + achievement scan triggered by `submitReview`. Runs
// OUTSIDE the review-create transaction (the controller schedules this via
// setImmediate AFTER the HTTP response has been sent), so a slow
// achievement scan or an XP-related Prisma error can never fail the review
// submission itself. Uses its own prisma.$transaction so the awardXp +
// achievement-unlock writes are atomic with each other.
//
// Returns the gamification engine result `{ xpResult, newAchievements }`
// (so the controller can emit the existing `gamification_update` socket
// event with REVIEW_RECEIVED type) or null on any error. Errors are caught
// and logged at the function boundary — the review row is already
// committed, gamification failures are non-fatal and forward-only on the
// next review or trade.
//
// Only call this when the reviewee is the vendor (XP rewards are
// vendor-only by design — buyers do not have an XP/level surface).
// =============================================================================
const processReviewGamification = async (prisma, { revieweeId, isPositive, tradeId }) => {
    try {
        const result = await prisma.$transaction(async (tx) => {
            const xpAmount = isPositive
                ? XP_REWARDS.POSITIVE_REVIEW
                : XP_REWARDS.NEGATIVE_REVIEW;

            const xpResult = await awardXp(
                tx,
                revieweeId,
                xpAmount,
                isPositive ? 'positive_review' : 'negative_review'
            );

            // Re-fetch the vendor's latest stats post-XP-award for the
            // achievement scan. The review-count increment happened in
            // the (already-committed) review-submission transaction so
            // it is visible here.
            const vendor = await tx.user.findUnique({
                where: { id: revieweeId },
                select: {
                    tradesCompleted: true,
                    totalVolumeUsdc: true,
                    totalProfitUsdc: true,
                    positiveReviews: true,
                    negativeReviews: true,
                    completionRate:  true,
                    currentStreak:   true,
                    longestStreak:   true,
                    kycStatus:       true
                }
            });

            const stats = {
                tradesCompleted: vendor.tradesCompleted,
                totalVolumeUsdc: vendor.totalVolumeUsdc,
                totalProfitUsdc: vendor.totalProfitUsdc,
                positiveReviews: vendor.positiveReviews,
                negativeReviews: vendor.negativeReviews,
                completionRate:  vendor.completionRate,
                currentStreak:   vendor.currentStreak,
                longestStreak:   vendor.longestStreak,
                kycVerified:     vendor.kycStatus === 'VERIFIED'
            };

            const newAchievements = await checkAndUnlockAchievements(tx, revieweeId, stats);

            return { xpResult, newAchievements };
        });

        // Phase N2: fire achievement notifications post-commit via notificationService
        if (result && result.newAchievements && result.newAchievements.length > 0) {
            const NotificationService = require('./notificationService');
            const { AzmRewardService } = require('./azmRewardService');
            const io = global.socketIoInstance;
            const notifSvc = new NotificationService(prisma, io);
            const azmSvc = new AzmRewardService(prisma, io);

            const notifications = result.newAchievements.map(a => ({
                userId: revieweeId,
                title: `🎖️ Achievement Unlocked: ${a.name}`,
                body: `${a.description} (+${a.xpReward} XP)`,
                category: 'VENDOR_PRIORITY',
                actionPayload: {
                    action: 'VIEW_ACHIEVEMENT',
                    achievementId: a.achievementId,
                    tier: a.tier
                }
            }));

            setImmediate(() => {
                Promise.all([
                    ...notifications.map(n => notifSvc.sendNotification(n)),
                    // Phase E1: Award AZM for each achievement unlock
                    ...result.newAchievements.map(a =>
                        azmSvc.rewardAchievementUnlock(revieweeId, a.achievementId, a.name, a.tier)
                    )
                ]).catch(err => console.error('[gamification.reviewGamification] post-commit notif/azm error:', err.message));
            });
        }

        return result;
    } catch (gamErr) {
        console.error(
            `[gamification.processReviewGamification] tradeId=${tradeId} ` +
            `revieweeId=${revieweeId} non-fatal error: ${gamErr.message}`
        );
        return null;
    }
};

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
    LEVEL_THRESHOLDS,
    XP_REWARDS,
    ACHIEVEMENT_DEFINITIONS,
    calculateLevel,
    getNextLevelInfo,
    updateStreak,
    awardXp,
    checkAndUnlockAchievements,
    processTradeCompletion,
    processReviewGamification
};
