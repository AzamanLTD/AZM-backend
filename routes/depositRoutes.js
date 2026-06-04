// routes/depositRoutes.js
// =============================================================================
// AZAMAN V2 — DEPOSIT ROUTES
//
// Local fiat deposits use a two-step flow:
//   1. POST /api/deposit/fiat/initiate  — auth required, returns reference
//   2. POST /api/deposit/fiat/webhook   — payment aggregator confirms (no JWT,
//                                         shared-secret X-Azaman-Webhook-Secret)
//
// Crypto deposits remain webhook-driven via the canonical finance.service path
// (POST /api/finance/webhook/deposit). The Tatum-specific shim here delegates
// to the same service so there is exactly one crypto-deposit code path.
//
// The legacy POST /api/deposit/transfer route was removed — internal transfers
// happen via POST /api/chat/transfer (chatTransferController.chatTransfer).
// =============================================================================

const express              = require('express');
const router               = express.Router();
const depositController    = require('../controllers/depositController');
const { protectActive }    = require('../middleware/banGuardMiddleware');

// 1. Initiate Local Fiat Deposit (creates PENDING TransactionHistory)
router.post('/fiat/initiate',  protectActive, depositController.initiateLocalFiatDeposit);

// 2. Local Fiat Deposit Webhook (no JWT — secured by X-Azaman-Webhook-Secret)
router.post('/fiat/webhook',   depositController.localFiatDepositWebhook);

// 3. Tatum Crypto Webhook (legacy alias — delegates to finance.service)
router.post('/webhook/tatum',  depositController.tatumCryptoWebhook);

module.exports = router;
