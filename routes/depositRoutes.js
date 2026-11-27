// routes/depositRoutes.js
// =============================================================================
// AZAMAN V2 — DEPOSIT ROUTES
//
// Local fiat deposits use a two-step flow:
//   1. POST /api/deposit/fiat/initiate  — auth required, returns a persisted quote
//   2. POST /api/deposit/fiat/webhook   — payment aggregator confirms settlement
//
// Crypto deposits are webhook-driven through the verified Tatum webhook
// (POST /api/finance/webhook/tatum). The old unauthenticated
// POST /api/finance/webhook/deposit is retired and answers 410.
//
// The legacy POST /api/deposit/transfer route was removed — internal transfers
// happen via the canonical peer-transfer rail (POST /api/friends/transfer/...).
// =============================================================================

const express = require('express');
const { requireKyc } = require('../middleware/requireKyc');
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

router.post('/fiat/initiate', protectActive, requireKyc('deposit'), idempotency(), validate(initiateFiatDepositSchema), quoteFiatDepositController.initiate);
router.post('/fiat/webhook', quoteFiatDepositController.webhook);
router.post('/webhook/tatum', depositController.tatumCryptoWebhook);

// All Moolre initiation/OTP/webhook mutations use the quote-backed controllers.
// Do not route financial settlement through the legacy depositController copies.
router.post('/fiat/initiate/moolre', protectActive, requireKyc('deposit'), idempotency(), validate(initiateMoolreFiatDepositSchema), quoteMoolreDepositController.initiate);
router.post('/fiat/initiate/moolre/otp', protectActive, quoteFiatDepositController.confirmMoolreOtp);
router.post('/fiat/webhook/moolre', quoteMoolreDepositController.webhook);
router.post('/validate-name', protectActive, depositController.validateMomoName);

module.exports = router;
