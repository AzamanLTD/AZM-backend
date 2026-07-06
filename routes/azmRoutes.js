// routes/azmRoutes.js
// =============================================================================
// AZAMAN — AZM ROUTES (Phase E1 + E2)
//
// EARN (Phase E1):
//   GET /api/azm/history   — Paginated AZM earn history (auth required)
//   GET /api/azm/summary   — AZM earnings summary (auth required)
//   GET /api/azm/rates     — Current earn rates (public)
//
// SPEND (Phase E2):
//   GET  /api/azm/spend/options      — Available spend options with affordability
//   POST /api/azm/spend/fee-discount — Spend AZM for withdrawal fee discount
//   POST /api/azm/spend/ad-boost     — Spend AZM to boost an ad
//   GET  /api/azm/spend/history      — Paginated AZM spend history
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const azmRewardController = require('../controllers/azmRewardController');
const azmSpendController = require('../controllers/azmSpendController');

// ── EARN (Phase E1) ──────────────────────────────────────────────────────────

// Public endpoint — anyone can see the earn rates
router.get('/rates', azmRewardController.getRates);

// Authenticated endpoints
router.get('/history', protect, azmRewardController.getHistory);
router.get('/summary', protect, azmRewardController.getSummary);
router.get('/friends-leaderboard', protect, azmRewardController.getFriendsLeaderboard);

// ── SPEND (Phase E2) ─────────────────────────────────────────────────────────

router.get('/spend/options', protect, azmSpendController.getSpendOptions);
router.post('/spend/fee-discount', protect, azmSpendController.applyFeeDiscount);
router.post('/spend/ad-boost', protect, azmSpendController.boostAd);
router.get('/spend/history', protect, azmSpendController.getSpendHistory);

// ── CARD SKINS (2026-07-06) ──────────────────────────────────────────────────
router.get('/spend/card-skins', protect, azmSpendController.getCardSkinCatalog);
router.post('/spend/card-skin/purchase', protect, azmSpendController.purchaseCardSkin);
router.post('/spend/card-skin/equip', protect, azmSpendController.equipCardSkin);

module.exports = router;
