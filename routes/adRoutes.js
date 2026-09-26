// routes/adRoutes.js
// =============================================================================
// AZAMAN V3 — AD ROUTES (Updated with Interaction Analytics)
// Mounted at /api/ads. Public read of the marketplace stays open; any write
// (create/toggle/deactivate) requires an ACTIVE banStatus.
//
// IMPORTANT: Static routes (/analytics/overview, /analytics/timeline) are
// registered BEFORE parameterized routes (/:id/...) to prevent Express from
// matching "analytics" as an :id parameter.
// =============================================================================

const logger = require('../src/config/logger');
const express              = require('express');
const router               = express.Router();
const adController         = require('../controllers/adController');
const adInteraction        = require('../controllers/adInteractionController');
const { protect }          = require('../middleware/authMiddleware');
const { protectActive }    = require('../middleware/banGuardMiddleware');

// ─── CRUD OPERATIONS ─────────────────────────────────────────────────────────

// 1. Create ad (write — gated)
router.post('/create',           protectActive, adController.createAd);

// 2. Public marketplace feed
router.get('/active',            adController.getMarketplaceAds);

// 4. Vendor's own ads (read-only)
router.get('/mine',              protect,       adController.getMyAds);

// ─── INTERACTION ANALYTICS (static paths first!) ─────────────────────────────

// 6. Get aggregated analytics overview for all vendor's ads
//    GET /api/ads/analytics/overview?period=7d|30d|90d|all
router.get('/analytics/overview', protect,      adInteraction.getVendorAnalyticsOverview);

// 7. Get daily timeline data for charts
//    GET /api/ads/analytics/timeline?days=7|14|30
router.get('/analytics/timeline', protect,      adInteraction.getAnalyticsTimeline);

// 7b. Quick analytics snapshot (for floating pull-tab preview)
//     GET /api/ads/analytics/quick
router.get('/analytics/quick',    protect,      adInteraction.getVendorAnalyticsQuick);

// ─── PARAMETERIZED ROUTES (after static routes) ──────────────────────────────

// 8. Log an ad interaction (VIEWED, TRADE_INITIATED, CLOSED)
//    POST /api/ads/:id/interaction
//    Body: { type: 'VIEWED' | 'TRADE_INITIATED' | 'CLOSED', metadata?: {} }
router.post('/:id/interaction',  protect,       adInteraction.logInteraction);

// 8b. Get lightweight ad summary (3 core metrics — for card flip popup)
//     GET /api/ads/:id/summary
router.get('/:id/summary',       protect,       adInteraction.getAdSummary);

// 9. Get analytics for a single ad (vendor-only, checks ownership)
//    GET /api/ads/:id/analytics?period=7d|30d|90d|all
router.get('/:id/analytics',     protect,       adInteraction.getAdAnalytics);

// 3. Vendor self-service deactivate (write — gated)
router.put('/:id/deactivate',    protectActive, adController.deactivateAd);

// 5. Toggle ad status (write — gated)
router.put('/:id/toggle',        protectActive, adController.toggleAdStatus);

// 6. Archive (soft-delete) an ad (write — gated)
router.delete('/:id',            protectActive, adController.archiveAd);

module.exports = router;
