// routes/p2pRoutes.js
// =============================================================================
// AZAMAN V2 — P2P ROUTES
// Mounted at /api/p2p. All routes are protected AND gated by the V2 ban guard.
// =============================================================================

const express              = require('express');
const router               = express.Router();
const p2pController        = require('../controllers/p2p.controller');
const { protectActive }    = require('../middleware/banGuardMiddleware');

// Ping system
router.post('/ping',         protectActive, p2pController.pingVendor);
router.post('/ping/accept',  protectActive, p2pController.acceptPing);

// P2P Ads listing (public — no auth required for browsing marketplace)
router.get('/ads', p2pController.getAds);

// Trade adjustments
router.post('/underpayment', protectActive, p2pController.markUnderpaid);
router.post('/overpayment',  protectActive, p2pController.flagOverpayment);

// Trade completion (the SINGLE SOURCE OF TRUTH for asset release)
router.post('/complete',     protectActive, p2pController.completeTrade);

module.exports = router;
