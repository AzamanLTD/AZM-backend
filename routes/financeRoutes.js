// routes/financeRoutes.js
// =============================================================================
// AZAMAN V2 — FINANCE ROUTES   (Phase B)
// Mounted at /api/finance.
// =============================================================================

const logger = require('../src/config/logger');
const express                  = require('express');
const router                   = express.Router();
const financeController        = require('../controllers/finance.controller');
const fiatSettlementWebhook    = require('../controllers/fiatSettlementWebhook.controller');
const { adminOnly }            = require('../middleware/authMiddleware');
const { protect }              = require('../middleware/authMiddleware');
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

// Webhook endpoints (no auth — external providers).
router.post('/webhook/deposit', financeController.cryptoDepositWebhook);

// Provider settlement callbacks are deliberately routed through the dedicated
// adapter. The old controller handlers remain available for compatibility, but
// are no longer the production route: callbacks now transition the canonical
// TransactionHistory row immediately and emit one normalized realtime contract.
router.post('/webhook/mtn-disbursement', fiatSettlementWebhook.mtnDisbursementWebhook);
router.post('/webhook/moolre-disbursement', fiatSettlementWebhook.moolreDisbursementWebhook);

// Phase C: Tatum Polygon deposit webhook (canonical V2 path)
const depositController = require('../controllers/depositController');
router.post('/webhook/tatum', depositController.tatumCryptoWebhook);

// Public read-only — frontend uses this to render the "limited fiat" tag
// before the user opens the withdraw flow. Returns HEALTHY|LIMITED|CRITICAL.
router.get('/fiat-pool-status', financeController.getFiatPoolStatus);

// B-9: Transaction history — authenticated user's own ledger with filters.
router.get('/transactions', protect, financeController.getTransactionHistory);

// Phase 3: Spending insights — server-side aggregation for the analytics screen
router.get('/spending-insights', protect, financeController.getSpendingInsights);

// C-4: Transaction receipt — structured JSON data for PDF rendering
router.get('/transactions/:id/receipt', protect, financeController.getTransactionReceipt);

module.exports = router;
