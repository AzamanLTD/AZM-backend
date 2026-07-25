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

const logger = require('../src/config/logger');
const express              = require('express');
const router               = express.Router();
const depositController    = require('../controllers/depositController');
const { idempotency } = require('../middleware/idempotency');
const { protectActive }    = require('../middleware/banGuardMiddleware');
const { validate }         = require('../middleware/validate');
const { initiateFiatDepositSchema, initiateMoolreFiatDepositSchema } = require('../services/validation/financialSchemas');

// 1. Initiate Local Fiat Deposit (creates PENDING TransactionHistory)
router.post('/fiat/initiate',  protectActive, idempotency(), validate(initiateFiatDepositSchema), depositController.initiateLocalFiatDeposit);

// 2. Local Fiat Deposit Webhook (no JWT — secured by X-Azaman-Webhook-Secret)
router.post('/fiat/webhook',   depositController.localFiatDepositWebhook);

// 3. Tatum Crypto Webhook (legacy alias — delegates to finance.service)
router.post('/webhook/tatum',  depositController.tatumCryptoWebhook);

// ── Moolre MoMo PIN-push collection on-ramp (2026-06-23) ──────────────────────
router.post('/fiat/initiate/moolre',     protectActive, idempotency(), validate(initiateMoolreFiatDepositSchema), depositController.initiateMoolreFiatDeposit);
router.post('/fiat/initiate/moolre/otp', protectActive, depositController.confirmMoolreOtp);
router.post('/fiat/webhook/moolre',      depositController.moolreCollectionWebhook); // no JWT — secret-guarded
router.post('/validate-name',            protectActive, depositController.validateMomoName);

module.exports = router;
