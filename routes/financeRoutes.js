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
const { idempotency }          = require('../middleware/idempotency');
const { require2FA }           = require('../middleware/require2FA');
const { validate }             = require('../middleware/validate');
const { fiatWithdrawalSchema } = require('../services/validation/financialSchemas');
const withdrawalController     = require('../controllers/withdrawalController');

// r42 WAVE-2 — FIAT WITHDRAWAL UNIFICATION.
//
// Topology audit (docs/audit/r42-wave2-withdrawal-authority.md): this route
// was the LIVE Flutter fiat withdrawal path while the hardened
// POST /api/withdraw/fiat (canonical) went unused — the live flow therefore
// bypassed the shared financial idempotency authority, step-up 2FA and the
// Withdrawal mirror bookkeeping entirely. The two independent financial
// implementations are GONE: this route is now a thin COMPATIBILITY ALIAS to
// the SAME canonical controller (withdrawalController.fiatWithdrawal) with the
// SAME full financial authority on the alias — the same r42 idempotency claim
// contract (in-transaction commit, deterministic accepted/pending response),
// the same step-up 2FA, the same zod validation. Nothing can reach the money
// without passing the canonical authority, on either path.
//
// The alias stays mounted for backward compatibility with released Flutter
// builds in the wild; new clients call POST /api/withdraw/fiat (PR
// AzamanLTD/AZM-frontend#94 migrates the production flow). The endpoint
// identity recorded on the FinancialOperation claim includes the route path,
// so a key used here is independent from the same key on the canonical route —
// the authority is enforced per-surface and can never be bypassed.
//
// NOTE: `protectActive` (ban guard) is kept as the alias's session guard, one
// notch stronger than the canonical route's `protect`.
router.post('/withdraw/fiat',
    protectActive,
    require2FA(),
    idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }),
    validate(fiatWithdrawalSchema),
    withdrawalController.fiatWithdrawal);

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
// r16b P0-A: the historical direct-MTN settlement webhook is NO LONGER an
// active production settlement surface. Azaman has no direct MTN provider
// contract — MTN/Telecel/AirtelTigo are destination networks under Moolre.
// The handler export remains in fiatSettlementWebhook.controller for
// historical reconciliation tooling and tests, but an unauthenticated
// legacy rail must never be able to mutate current fiat payouts. The
// canonical provider callback/status path is the Moolre webhook below.
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
