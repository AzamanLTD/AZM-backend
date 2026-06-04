// routes/financeRoutes.js
// =============================================================================
// AZAMAN V2 — FINANCE ROUTES   (Phase B)
// Mounted at /api/finance.
// =============================================================================

const express                  = require('express');
const router                   = express.Router();
const financeController        = require('../controllers/finance.controller');
const { adminOnly }            = require('../middleware/authMiddleware');
const { protectActive }        = require('../middleware/banGuardMiddleware');

// User endpoints (protected + ban-guarded)
router.post('/withdraw/fiat', protectActive, financeController.fiatWithdrawal);

// Admin endpoints (protectActive runs first so admin must also be ACTIVE)
router.post(
    '/admin/liquidate-profits',
    protectActive,
    adminOnly,
    financeController.liquidateProfits
);

// Webhook endpoints (no auth — external providers; idempotency via txHash)
router.post('/webhook/deposit',          financeController.cryptoDepositWebhook);
router.post('/webhook/mtn-disbursement', financeController.mtnDisbursementWebhook);

// Phase C: Tatum Polygon deposit webhook (canonical V2 path)
// Tatum POSTs here when USDC lands on a user's derived Polygon address.
// HMAC-verified via x-payload-hash header + TATUM_WEBHOOK_SECRET.
const depositController = require('../controllers/depositController');
router.post('/webhook/tatum', depositController.tatumCryptoWebhook);

// Public read-only — frontend uses this to render the "limited fiat" tag
// before the user opens the withdraw flow. Returns HEALTHY|LIMITED|CRITICAL.
router.get('/fiat-pool-status', financeController.getFiatPoolStatus);

module.exports = router;
