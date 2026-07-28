// routes/p2pRoutes.js
// =============================================================================
// AZAMAN V2 — P2P ROUTES
// Mounted at /api/p2p. All routes are protected AND gated by the V2 ban guard.
// =============================================================================

const logger = require('../src/config/logger');
const express              = require('express');
const router               = express.Router();
const p2pController        = require('../controllers/p2p.controller');
const { protectActive }    = require('../middleware/banGuardMiddleware');
const { idempotency }      = require('../middleware/idempotency');

// Ping system
router.post('/ping',         protectActive, p2pController.pingVendor);
router.post('/ping/accept',  protectActive, idempotency(), p2pController.acceptPing);

// P2P Ads listing (public — no auth required for browsing marketplace)
router.get('/ads', p2pController.getAds);

// Trade adjustments
router.post('/underpayment', protectActive, idempotency(), p2pController.markUnderpaid);
router.post('/overpayment',  protectActive, idempotency(), p2pController.flagOverpayment);

// Trade completion (the SINGLE SOURCE OF TRUTH for asset release)
router.post('/complete',     protectActive, require2FA(), idempotency(), p2pController.completeTrade);

// B-9: Action-required indicator — returns pending items needing user attention.
router.get('/action-required', protectActive, p2pController.getActionRequired);

module.exports = router;
