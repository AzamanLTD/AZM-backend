// routes/depositRoutes.js
// =============================================================================
// AZAMAN V2 — DEPOSIT ROUTES
//
// Local fiat deposits use a two-step flow:
//   1. POST /api/deposit/fiat/initiate  — auth required, returns a persisted quote
//   2. POST /api/deposit/fiat/webhook   — payment aggregator confirms settlement
//
// Crypto deposits remain webhook-driven via the canonical finance.service path
// (POST /api/finance/webhook/deposit). The Tatum-specific shim here delegates
// to the same service so there is exactly one crypto-deposit code path.
//
// The legacy POST /api/deposit/transfer route was removed — internal transfers
// happen via POST /api/chat/transfer (chatTransferController.chatTransfer).
// =============================================================================

const express = require('express');
const router = express.Router();
const depositController = require('../controllers/depositController');
const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
const quoteMoolreDepositController = require('../controllers/moolreQuoteDepositController');
const { idempotency } = require('../middleware/idempotency');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { validate } = require('../middleware/validate');
const {
  initiateFiatDepositSchema,
  initiateMoolreFiatDepositSchema,
} = require('../services/validation/financialSchemas');

// Quote-backed local fiat deposit. The quote is persisted before the pending
// transaction is created and is consumed atomically with wallet credit.
router.post(
  '/fiat/initiate',
  protectActive,
  idempotency(),
  validate(initiateFiatDepositSchema),
  quoteFiatDepositController.initiate,
);
router.post('/fiat/webhook', quoteFiatDepositController.webhook);

// Tatum Crypto Webhook (legacy alias — delegates to the existing crypto path).
router.post('/webhook/tatum', depositController.tatumCryptoWebhook);

// Moolre MoMo PIN-push collection on-ramp.
router.post(
  '/fiat/initiate/moolre',
  protectActive,
  idempotency(),
  validate(initiateMoolreFiatDepositSchema),
  quoteMoolreDepositController.initiate,
);
router.post('/fiat/initiate/moolre/otp', protectActive, depositController.confirmMoolreOtp);
router.post('/fiat/webhook/moolre', quoteMoolreDepositController.webhook);
router.post('/validate-name', protectActive, depositController.validateMomoName);

module.exports = router;
