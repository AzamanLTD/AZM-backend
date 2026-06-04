// controllers/azmSpendController.js
// =============================================================================
// AZAMAN — AZM SPEND CONTROLLER (Phase E2)
//
// Endpoints for spending AZM loyalty points on premium features.
//
// GET  /api/azm/spend/options       — Available spend options
// POST /api/azm/spend/fee-discount  — Apply fee discount (standalone, outside withdrawal flow)
// POST /api/azm/spend/ad-boost      — Boost an ad for featured placement
// GET  /api/azm/spend/history       — Paginated spend history
// =============================================================================

const { AZM_SPEND_SOURCES, FEE_DISCOUNT_TIERS, AD_BOOST_OPTIONS } = require('../services/azmSpendService');

// =============================================================================
// GET /api/azm/spend/options
// Returns available spend options with affordability based on user's balance
// =============================================================================
exports.getSpendOptions = async (req, res) => {
    try {
        const azmSpendService = req.app.get('azmSpendService');
        if (!azmSpendService) {
            return res.status(503).json({ success: false, message: 'AZM spend service unavailable.' });
        }

        const userId = req.user.id;
        const options = await azmSpendService.getSpendOptions(userId);

        return res.status(200).json({ success: true, data: options });
    } catch (error) {
        console.error('[azmSpend.getSpendOptions] Error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch spend options.' });
    }
};

// =============================================================================
// POST /api/azm/spend/fee-discount
// Body: { tierId: 'tier_25' | 'tier_50' | 'tier_100' }
//
// Standalone endpoint for pre-purchasing a fee discount before initiating
// a withdrawal. Returns a discount token the FE can pass to the withdrawal
// endpoint. Also usable directly by the withdrawal controller (wired in E2).
// =============================================================================
exports.applyFeeDiscount = async (req, res) => {
    try {
        const azmSpendService = req.app.get('azmSpendService');
        if (!azmSpendService) {
            return res.status(503).json({ success: false, message: 'AZM spend service unavailable.' });
        }

        const userId = req.user.id;
        const { tierId } = req.body;

        if (!tierId || typeof tierId !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'tierId is required. Valid options: ' + FEE_DISCOUNT_TIERS.map(t => t.id).join(', ')
            });
        }

        const validTier = FEE_DISCOUNT_TIERS.find(t => t.id === tierId);
        if (!validTier) {
            return res.status(400).json({
                success: false,
                message: `Invalid tierId "${tierId}". Valid options: ${FEE_DISCOUNT_TIERS.map(t => t.id).join(', ')}`
            });
        }

        const result = await azmSpendService.applyFeeDiscount(userId, tierId);

        return res.status(200).json({
            success: true,
            message: `${validTier.label} fee discount applied! ${validTier.cost} AZM spent.`,
            data: {
                discount: result.discount,
                discountPercent: `${(result.discount * 100).toFixed(0)}%`,
                azmSpent: result.azmSpent,
                newAzmBalance: result.newBalance
            }
        });
    } catch (error) {
        console.error('[azmSpend.applyFeeDiscount] Error:', error.message);

        if (error.message.includes('Insufficient AZM')) {
            return res.status(400).json({
                success: false,
                code: 'INSUFFICIENT_AZM',
                message: error.message
            });
        }

        return res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/azm/spend/ad-boost
// Body: { adId: number, boostId: 'boost_24h' | 'boost_72h' | 'boost_7d' }
// =============================================================================
exports.boostAd = async (req, res) => {
    try {
        const azmSpendService = req.app.get('azmSpendService');
        if (!azmSpendService) {
            return res.status(503).json({ success: false, message: 'AZM spend service unavailable.' });
        }

        const userId = req.user.id;
        const { adId, boostId } = req.body;

        if (!adId || isNaN(parseInt(adId, 10))) {
            return res.status(400).json({ success: false, message: 'adId is required (integer).' });
        }

        if (!boostId || typeof boostId !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'boostId is required. Valid options: ' + AD_BOOST_OPTIONS.map(o => o.id).join(', ')
            });
        }

        const validOption = AD_BOOST_OPTIONS.find(o => o.id === boostId);
        if (!validOption) {
            return res.status(400).json({
                success: false,
                message: `Invalid boostId "${boostId}". Valid options: ${AD_BOOST_OPTIONS.map(o => o.id).join(', ')}`
            });
        }

        const result = await azmSpendService.boostAd(userId, parseInt(adId, 10), boostId);

        // Emit marketplace update so other users see the boosted ad
        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        return res.status(200).json({
            success: true,
            message: `Ad #${adId} boosted for ${validOption.label}! ${validOption.cost} AZM spent.`,
            data: {
                adId: parseInt(adId, 10),
                boostDuration: validOption.label,
                boostExpiresAt: result.boostExpiresAt,
                azmSpent: result.azmSpent,
                newAzmBalance: result.newBalance
            }
        });
    } catch (error) {
        console.error('[azmSpend.boostAd] Error:', error.message);

        if (error.message.includes('Insufficient AZM')) {
            return res.status(400).json({
                success: false,
                code: 'INSUFFICIENT_AZM',
                message: error.message
            });
        }
        if (error.message.includes('not found') || error.message.includes('only boost your own')) {
            return res.status(403).json({ success: false, message: error.message });
        }

        return res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// GET /api/azm/spend/history
// Query params: ?cursor=<id>&limit=20&source=FEE_DISCOUNT
// =============================================================================
exports.getSpendHistory = async (req, res) => {
    try {
        const azmSpendService = req.app.get('azmSpendService');
        if (!azmSpendService) {
            return res.status(503).json({ success: false, message: 'AZM spend service unavailable.' });
        }

        const userId = req.user.id;
        const { cursor, limit, source } = req.query;

        const parsedLimit = limit ? Math.min(parseInt(limit, 10) || 20, 100) : 20;

        if (source && !Object.values(AZM_SPEND_SOURCES).includes(source)) {
            return res.status(400).json({
                success: false,
                message: `Invalid source filter. Valid options: ${Object.values(AZM_SPEND_SOURCES).join(', ')}`
            });
        }

        const result = await azmSpendService.getSpendHistory(userId, {
            cursor: cursor || undefined,
            limit: parsedLimit,
            source: source || undefined
        });

        return res.status(200).json({
            success: true,
            data: {
                spends: result.spends,
                pagination: {
                    nextCursor: result.nextCursor,
                    hasMore: result.hasMore,
                    limit: parsedLimit
                }
            }
        });
    } catch (error) {
        console.error('[azmSpend.getSpendHistory] Error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch AZM spend history.' });
    }
};
