// services/azmRewardService.js
// =============================================================================
// AZAMAN — AZM REWARD SERVICE (Phase E1)
//
// Manages all AZM loyalty-point earn mechanics. Every AZM credit flows
// through this service so we have one canonical pipeline with:
//   1. Atomic balance increment (DB-level CHECK ensures >= 0)
//   2. AzmRewardLog audit row (transparent history for the user)
//   3. Socket emission so the FE updates in real-time
//   4. Optional notification for milestone rewards
//
// EARN SOURCES & RATES:
//   TRADE_COMPLETE     → 5.0 AZM per completed trade (buyer receives)
//   LOGIN_STREAK       → 1.0 AZM per consecutive day, 5.0 bonus at 7-day, 20.0 at 30-day
//   REFERRAL_BONUS     → 10.0 AZM when your referred user completes their first trade
//   ACHIEVEMENT_UNLOCK → 2.0–25.0 AZM depending on achievement tier
//   MILESTONE          → 50.0 AZM for volume milestones ($1k, $10k, $50k, $100k)
//
// DESIGN DECISIONS:
//   - AZM is NEVER decremented by this service (spend mechanics are Phase E2)
//   - Fire-and-forget pattern: errors are caught and logged, never propagated
//   - Socket emission uses the existing `balance_update` event for consistency
//   - Each credit is idempotent via source+metadata dedup check
// =============================================================================

// ── AZM Reward Rates ─────────────────────────────────────────────────────────
const AZM_RATES = {
    TRADE_COMPLETE:           5.0,    // Per completed trade (buyer side)
    LOGIN_STREAK_DAILY:       1.0,    // Per consecutive login day
    LOGIN_STREAK_7_DAY:       5.0,    // Bonus at 7-day streak
    LOGIN_STREAK_30_DAY:      20.0,   // Bonus at 30-day streak
    LOGIN_STREAK_90_DAY:      50.0,   // Bonus at 90-day streak
    REFERRAL_FIRST_TRADE:     10.0,   // Referrer earns when referred user completes first trade
    ACHIEVEMENT_COMMON:       2.0,    // Common tier achievement unlock
    ACHIEVEMENT_RARE:         5.0,    // Rare tier
    ACHIEVEMENT_EPIC:         10.0,   // Epic tier
    ACHIEVEMENT_LEGENDARY:    25.0,   // Legendary tier
    MILESTONE_VOLUME_1K:      50.0,   // First $1k volume
    MILESTONE_VOLUME_10K:     100.0,  // $10k volume
    MILESTONE_VOLUME_50K:     200.0,  // $50k volume
    MILESTONE_VOLUME_100K:    500.0,  // $100k volume
};

// ── Source keys (machine-readable, stored in AzmRewardLog.source) ────────────
const AZM_SOURCES = {
    TRADE_COMPLETE:       'TRADE_COMPLETE',
    LOGIN_STREAK:         'LOGIN_STREAK',
    REFERRAL_BONUS:       'REFERRAL_BONUS',
    ACHIEVEMENT_UNLOCK:   'ACHIEVEMENT_UNLOCK',
    MILESTONE:            'MILESTONE',
    // Master Sprint (2026-05-27)
    VAULT_INTENSITY:      'VAULT_INTENSITY',
    VAULT_COMPLETION:     'VAULT_COMPLETION',
    SUSU_COMPLETION:      'SUSU_COMPLETION',
};

class AzmRewardService {
    /**
     * @param {object} prisma - Prisma client instance
     * @param {object|null} io - Socket.IO server instance (for real-time updates)
     */
    constructor(prisma, io = null) {
        this.prisma = prisma;
        this.io = io;
    }

    // =========================================================================
    // CORE: Credit AZM to a user
    // =========================================================================

    /**
     * Credit AZM to a user with full audit trail.
     * Idempotent: if a reward with the same source + dedup key exists, skips.
     *
     * @param {object} params
     * @param {number} params.userId - Target user ID
     * @param {number} params.amount - AZM to credit (must be > 0)
     * @param {string} params.source - Machine key (from AZM_SOURCES)
     * @param {string} params.reason - Human-readable description
     * @param {object} [params.metadata] - Optional context (tradeId, streak, etc.)
     * @param {string} [params.dedupKey] - Optional idempotency key within source
     * @returns {Promise<{credited: boolean, newBalance: number, logId: string|null}>}
     */
    async creditAzm({ userId, amount, source, reason, metadata = null, dedupKey = null }) {
        try {
            if (!userId || !amount || amount <= 0 || !source || !reason) {
                console.error('[AzmRewardService.creditAzm] Invalid params:', { userId, amount, source });
                return { credited: false, newBalance: 0, logId: null };
            }

            // Idempotency check: prevent double-crediting for the same event
            if (dedupKey) {
                const existing = await this.prisma.azmRewardLog.findFirst({
                    where: {
                        userId,
                        source,
                        metadata: { path: ['dedupKey'], equals: dedupKey }
                    }
                });
                if (existing) {
                    return { credited: false, newBalance: existing.balanceAfter, logId: existing.id };
                }
            }

            // Atomic: increment balance + create log in one transaction
            const result = await this.prisma.$transaction(async (tx) => {
                const updatedUser = await tx.user.update({
                    where: { id: userId },
                    data: { azmBalance: { increment: amount } },
                    select: { azmBalance: true }
                });

                const log = await tx.azmRewardLog.create({
                    data: {
                        userId,
                        amount,
                        source,
                        reason,
                        metadata: dedupKey
                            ? { ...metadata, dedupKey }
                            : metadata,
                        balanceAfter: updatedUser.azmBalance
                    }
                });

                return { newBalance: updatedUser.azmBalance, logId: log.id };
            });

            // Emit socket event so FE updates in real-time
            this._emitBalanceUpdate(userId, result.newBalance, amount, source, reason);

            return { credited: true, ...result };
        } catch (err) {
            console.error(`[AzmRewardService.creditAzm] userId=${userId} source=${source} error:`, err.message);
            return { credited: false, newBalance: 0, logId: null };
        }
    }

    // =========================================================================
    // TRADE COMPLETION REWARD
    // Called post-commit from p2p.controller after completeTrade
    // =========================================================================

    /**
     * Award AZM to the buyer on trade completion.
     * @param {number} userId - Buyer ID
     * @param {number} tradeId - Completed trade ID
     * @param {number} amountCrypto - Trade volume in USDC
     */
    async rewardTradeComplete(userId, tradeId, amountCrypto) {
        return this.creditAzm({
            userId,
            amount: AZM_RATES.TRADE_COMPLETE,
            source: AZM_SOURCES.TRADE_COMPLETE,
            reason: `Trade #${tradeId} completed (+${AZM_RATES.TRADE_COMPLETE} AZM)`,
            metadata: { tradeId, amountCrypto },
            dedupKey: `trade_${tradeId}`
        });
    }

    // =========================================================================
    // LOGIN STREAK REWARD
    // Called from authController after login streak is updated
    // =========================================================================

    /**
     * Award AZM for maintaining a login streak.
     * Daily reward + milestone bonuses at 7, 30, 90 days.
     *
     * @param {number} userId
     * @param {number} newStreak - The current streak count AFTER today's login
     * @returns {Promise<{totalAwarded: number, rewards: Array}>}
     */
    async rewardLoginStreak(userId, newStreak) {
        const rewards = [];

        // Only award if streak increased (consecutive day)
        if (newStreak <= 0) return { totalAwarded: 0, rewards: [] };

        // Daily AZM
        const dailyResult = await this.creditAzm({
            userId,
            amount: AZM_RATES.LOGIN_STREAK_DAILY,
            source: AZM_SOURCES.LOGIN_STREAK,
            reason: `Day ${newStreak} login streak (+${AZM_RATES.LOGIN_STREAK_DAILY} AZM)`,
            metadata: { streak: newStreak, type: 'daily' },
            dedupKey: `login_streak_${_todayKey()}_${userId}`
        });
        if (dailyResult.credited) {
            rewards.push({ type: 'daily', amount: AZM_RATES.LOGIN_STREAK_DAILY, streak: newStreak });
        }

        // 7-day milestone bonus
        if (newStreak === 7) {
            const bonusResult = await this.creditAzm({
                userId,
                amount: AZM_RATES.LOGIN_STREAK_7_DAY,
                source: AZM_SOURCES.LOGIN_STREAK,
                reason: `7-day login streak bonus! (+${AZM_RATES.LOGIN_STREAK_7_DAY} AZM)`,
                metadata: { streak: 7, type: 'milestone_7' },
                dedupKey: `login_milestone_7_${userId}_${_weekKey()}`
            });
            if (bonusResult.credited) {
                rewards.push({ type: 'milestone_7', amount: AZM_RATES.LOGIN_STREAK_7_DAY });
            }
        }

        // 30-day milestone bonus
        if (newStreak === 30) {
            const bonusResult = await this.creditAzm({
                userId,
                amount: AZM_RATES.LOGIN_STREAK_30_DAY,
                source: AZM_SOURCES.LOGIN_STREAK,
                reason: `30-day login streak bonus! (+${AZM_RATES.LOGIN_STREAK_30_DAY} AZM)`,
                metadata: { streak: 30, type: 'milestone_30' },
                dedupKey: `login_milestone_30_${userId}_${_monthKey()}`
            });
            if (bonusResult.credited) {
                rewards.push({ type: 'milestone_30', amount: AZM_RATES.LOGIN_STREAK_30_DAY });
            }
        }

        // 90-day milestone bonus
        if (newStreak === 90) {
            const bonusResult = await this.creditAzm({
                userId,
                amount: AZM_RATES.LOGIN_STREAK_90_DAY,
                source: AZM_SOURCES.LOGIN_STREAK,
                reason: `90-day login streak bonus! (+${AZM_RATES.LOGIN_STREAK_90_DAY} AZM)`,
                metadata: { streak: 90, type: 'milestone_90' },
                dedupKey: `login_milestone_90_${userId}_${_quarterKey()}`
            });
            if (bonusResult.credited) {
                rewards.push({ type: 'milestone_90', amount: AZM_RATES.LOGIN_STREAK_90_DAY });
            }
        }

        const totalAwarded = rewards.reduce((sum, r) => sum + r.amount, 0);
        return { totalAwarded, rewards };
    }

    // =========================================================================
    // REFERRAL BONUS
    // Called when a referred user completes their FIRST trade
    // =========================================================================

    /**
     * Award AZM to the referrer when their referred user completes first trade.
     * @param {number} referrerId - User who referred
     * @param {number} referredUserId - User who was referred and completed trade
     * @param {number} tradeId - The first trade that triggered this
     */
    async rewardReferralFirstTrade(referrerId, referredUserId, tradeId) {
        return this.creditAzm({
            userId: referrerId,
            amount: AZM_RATES.REFERRAL_FIRST_TRADE,
            source: AZM_SOURCES.REFERRAL_BONUS,
            reason: `Referral bonus — your invited user completed their first trade! (+${AZM_RATES.REFERRAL_FIRST_TRADE} AZM)`,
            metadata: { referredUserId, tradeId },
            dedupKey: `referral_first_trade_${referredUserId}`
        });
    }

    // =========================================================================
    // ACHIEVEMENT UNLOCK REWARD
    // Called from vendorGamificationService when achievements are unlocked
    // =========================================================================

    /**
     * Award AZM when an achievement is unlocked.
     * @param {number} userId
     * @param {string} achievementId
     * @param {string} achievementName
     * @param {string} tier - COMMON, RARE, EPIC, LEGENDARY
     */
    async rewardAchievementUnlock(userId, achievementId, achievementName, tier) {
        const rateMap = {
            COMMON:    AZM_RATES.ACHIEVEMENT_COMMON,
            RARE:      AZM_RATES.ACHIEVEMENT_RARE,
            EPIC:      AZM_RATES.ACHIEVEMENT_EPIC,
            LEGENDARY: AZM_RATES.ACHIEVEMENT_LEGENDARY,
        };
        const amount = rateMap[tier] || AZM_RATES.ACHIEVEMENT_COMMON;

        return this.creditAzm({
            userId,
            amount,
            source: AZM_SOURCES.ACHIEVEMENT_UNLOCK,
            reason: `Achievement unlocked: ${achievementName} (+${amount} AZM)`,
            metadata: { achievementId, tier },
            dedupKey: `achievement_${achievementId}_${userId}`
        });
    }

    // =========================================================================
    // VOLUME MILESTONE REWARD
    // Called from vendorGamificationService when volume thresholds are crossed
    // =========================================================================

    /**
     * Award AZM for reaching a volume milestone.
     * @param {number} userId
     * @param {number} milestoneUsdc - The threshold crossed (1000, 10000, 50000, 100000)
     * @param {number} currentVolume - User's current total volume
     */
    async rewardVolumeMilestone(userId, milestoneUsdc, currentVolume) {
        const rateMap = {
            1000:   AZM_RATES.MILESTONE_VOLUME_1K,
            10000:  AZM_RATES.MILESTONE_VOLUME_10K,
            50000:  AZM_RATES.MILESTONE_VOLUME_50K,
            100000: AZM_RATES.MILESTONE_VOLUME_100K,
        };
        const amount = rateMap[milestoneUsdc];
        if (!amount) return { credited: false, newBalance: 0, logId: null };

        return this.creditAzm({
            userId,
            amount,
            source: AZM_SOURCES.MILESTONE,
            reason: `Volume milestone reached: $${milestoneUsdc.toLocaleString()} traded (+${amount} AZM)`,
            metadata: { milestoneUsdc, currentVolume },
            dedupKey: `volume_milestone_${milestoneUsdc}_${userId}`
        });
    }

    // =========================================================================
    // QUERY: Get user's AZM reward history (paginated)
    // =========================================================================

    /**
     * Fetch paginated AZM reward history for a user.
     * @param {number} userId
     * @param {object} [opts]
     * @param {string} [opts.cursor] - Cursor for pagination
     * @param {number} [opts.limit=20] - Page size
     * @param {string} [opts.source] - Filter by source type
     * @returns {Promise<{rewards: Array, nextCursor: string|null, hasMore: boolean}>}
     */
    async getRewardHistory(userId, { cursor, limit = 20, source } = {}) {
        const where = { userId };
        if (source) where.source = source;

        const take = Math.min(limit, 100);
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: take + 1,
            select: {
                id: true,
                amount: true,
                reason: true,
                source: true,
                metadata: true,
                balanceAfter: true,
                createdAt: true
            }
        };

        if (cursor) {
            findArgs.cursor = { id: cursor };
            findArgs.skip = 1;
        }

        const rows = await this.prisma.azmRewardLog.findMany(findArgs);
        const hasMore = rows.length > take;
        const rewards = hasMore ? rows.slice(0, take) : rows;
        const nextCursor = hasMore ? rewards[rewards.length - 1].id : null;

        return { rewards, nextCursor, hasMore };
    }

    /**
     * Get summary stats for a user's AZM earnings.
     * @param {number} userId
     * @returns {Promise<{totalEarned: number, currentBalance: number, bySource: object}>}
     */
    async getRewardSummary(userId) {
        const [user, bySource] = await Promise.all([
            this.prisma.user.findUnique({
                where: { id: userId },
                select: { azmBalance: true }
            }),
            this.prisma.azmRewardLog.groupBy({
                by: ['source'],
                where: { userId },
                _sum: { amount: true },
                _count: true
            })
        ]);

        const totalEarned = bySource.reduce((sum, g) => sum + (g._sum.amount || 0), 0);
        const sourceBreakdown = {};
        for (const group of bySource) {
            sourceBreakdown[group.source] = {
                total: group._sum.amount || 0,
                count: group._count
            };
        }

        return {
            totalEarned,
            currentBalance: user?.azmBalance || 0,
            bySource: sourceBreakdown
        };
    }

    // =========================================================================
    // INTERNAL: Socket emission
    // =========================================================================

    _emitBalanceUpdate(userId, newAzmBalance, azmAwarded, source, reason) {
        if (!this.io) return;
        try {
            this.io.to(`user_${userId}`).emit('azm_reward', {
                azmBalance: newAzmBalance,
                awarded: azmAwarded,
                source,
                reason,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            console.error('[AzmRewardService._emitBalanceUpdate] socket error:', err.message);
        }
    }
}

// ── Date helpers for dedup keys ──────────────────────────────────────────────
function _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _weekKey() {
    const d = new Date();
    const week = Math.ceil(d.getDate() / 7);
    return `${d.getFullYear()}-W${String(d.getMonth() + 1).padStart(2, '0')}-${week}`;
}

function _monthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _quarterKey() {
    const d = new Date();
    const q = Math.ceil((d.getMonth() + 1) / 3);
    return `${d.getFullYear()}-Q${q}`;
}

module.exports = { AzmRewardService, AZM_RATES, AZM_SOURCES };
