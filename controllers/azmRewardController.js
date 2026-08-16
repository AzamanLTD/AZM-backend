// controllers/azmRewardController.js
// =============================================================================
// AZAMAN — AZM REWARD CONTROLLER (Phase E1)
//
// Endpoints for viewing AZM loyalty-point earn history and summary.
// All endpoints require authentication (protect middleware).
//
// GET /api/azm/history       — Paginated earn history
// GET /api/azm/summary       — Aggregated stats by source
// GET /api/azm/rates         — Current earn rates (public info)
// =============================================================================

const logger = require('../src/config/logger');
const { AZM_RATES, AZM_SOURCES } = require('../services/azmRewardService');

// =============================================================================
// GET /api/azm/history
// Query params: ?cursor=<id>&limit=20&source=TRADE_COMPLETE
// =============================================================================
exports.getHistory = async (req, res) => {
    try {
        const azmRewardService = req.app.get('azmRewardService');
        if (!azmRewardService) {
            return res.status(503).json({ success: false, message: 'AZM service unavailable.' });
        }

        const userId = req.user.id;
        const { cursor, limit, source } = req.query;

        const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 20, 100) : 20;

        // Validate source filter if provided
        if (source && !Object.values(AZM_SOURCES).includes(source)) {
            return res.status(400).json({
                success: false,
                message: `Invalid source filter. Valid options: ${Object.values(AZM_SOURCES).join(', ')}`
            });
        }

        const result = await azmRewardService.getRewardHistory(userId, {
            cursor: cursor || undefined,
            limit: parsedLimit,
            source: source || undefined
        });

        return res.status(200).json({
            success: true,
            data: {
                rewards: result.rewards,
                pagination: {
                    nextCursor: result.nextCursor,
                    hasMore: result.hasMore,
                    limit: parsedLimit
                }
            }
        });
    } catch (error) {
        logger.error({ err: error }, '[azmReward.getHistory] Error');
        return res.status(500).json({ success: false, message: 'Failed to fetch AZM history.' });
    }
};

// =============================================================================
// GET /api/azm/summary
// Returns total earned, current balance, and breakdown by source
// =============================================================================
exports.getSummary = async (req, res) => {
    try {
        const azmRewardService = req.app.get('azmRewardService');
        if (!azmRewardService) {
            return res.status(503).json({ success: false, message: 'AZM service unavailable.' });
        }

        const userId = req.user.id;
        const summary = await azmRewardService.getRewardSummary(userId);

        return res.status(200).json({
            success: true,
            data: summary
        });
    } catch (error) {
        logger.error({ err: error }, '[azmReward.getSummary] Error');
        return res.status(500).json({ success: false, message: 'Failed to fetch AZM summary.' });
    }
};

// =============================================================================
// GET /api/azm/friends-leaderboard
// Ranks the caller + their ACCEPTED friends by total AZM earned.
// Query params: ?limit=20 (max 50)
// =============================================================================
exports.getFriendsLeaderboard = async (req, res) => {
    try {
        const azmRewardService = req.app.get('azmRewardService');
        if (!azmRewardService) {
            return res.status(503).json({ success: false, message: 'AZM service unavailable.' });
        }

        const userId = req.user.id;
        const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 20, 50) : 20;

        const result = await azmRewardService.getFriendsLeaderboard(userId, limit);

        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        logger.error({ err: error }, '[azmReward.getFriendsLeaderboard] Error');
        return res.status(500).json({ success: false, message: 'Failed to fetch friends leaderboard.' });
    }
};

// =============================================================================
// GET /api/azm/rates
// Public: returns current AZM earn rates (no auth required for discovery)
// =============================================================================
exports.getRates = async (req, res) => {
    return res.status(200).json({
        success: true,
        data: {
            rates: {
                tradeComplete: {
                    amount: AZM_RATES.TRADE_COMPLETE,
                    description: 'AZM earned per completed trade (buyer)',
                    unit: 'per trade'
                },
                loginStreak: {
                    daily: AZM_RATES.LOGIN_STREAK_DAILY,
                    bonus7Day: AZM_RATES.LOGIN_STREAK_7_DAY,
                    bonus30Day: AZM_RATES.LOGIN_STREAK_30_DAY,
                    bonus90Day: AZM_RATES.LOGIN_STREAK_90_DAY,
                    description: 'AZM earned for consecutive daily logins'
                },
                referral: {
                    amount: AZM_RATES.REFERRAL_FIRST_TRADE,
                    description: 'AZM earned when your referred user completes their first trade'
                },
                achievements: {
                    COMMON: AZM_RATES.ACHIEVEMENT_COMMON,
                    RARE: AZM_RATES.ACHIEVEMENT_RARE,
                    EPIC: AZM_RATES.ACHIEVEMENT_EPIC,
                    LEGENDARY: AZM_RATES.ACHIEVEMENT_LEGENDARY,
                    description: 'AZM earned per achievement unlock (by tier)'
                },
                milestones: {
                    volume1k: AZM_RATES.MILESTONE_VOLUME_1K,
                    volume10k: AZM_RATES.MILESTONE_VOLUME_10K,
                    volume50k: AZM_RATES.MILESTONE_VOLUME_50K,
                    volume100k: AZM_RATES.MILESTONE_VOLUME_100K,
                    description: 'AZM earned at volume milestones'
                }
            },
            sources: Object.values(AZM_SOURCES),
            note: 'AZM is a loyalty reward — earned through platform activity, never purchased directly.'
        }
    });
};
