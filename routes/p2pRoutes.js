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
const { require2FA }    = require('../middleware/require2FA');

// Ping system
router.post('/ping',         protectActive, p2pController.pingVendor);
router.post('/ping/accept',  protectActive, idempotency(), p2pController.acceptPing);

// P2P Ads listing (public — no auth required for browsing marketplace)
router.get('/ads', p2pController.getAds);

// Trade adjustments
router.post('/underpayment', protectActive, idempotency(), p2pController.markUnderpaid);
router.post('/overpayment',  protectActive, idempotency(), p2pController.flagOverpayment);

// Trade completion (the SINGLE SOURCE OF TRUTH for asset release)
// §r42.1 wired: the claim commits INSIDE the settlement $transaction, so
// an IN_PROGRESS claim after a 4xx is durable proof of rollback — the key
// is safely releasable (releaseOn4xx). 5xx stays RETAIN (default): a
// post-commit failure must never re-settle a trade.
router.post('/complete',     protectActive, require2FA(), idempotency({ releaseOn4xx: true }), p2pController.completeTrade);

// B-9: Action-required indicator — returns pending items needing user attention.
router.get('/action-required', protectActive, p2pController.getActionRequired);

module.exports = router;
