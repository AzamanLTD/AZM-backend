const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const withdrawalController = require('../controllers/withdrawalController');
const authMiddleware = require('../middleware/authMiddleware');
const { validate } = require('../middleware/validate');
const { fiatWithdrawalSchema, cryptoWithdrawalSchema } = require('../services/validation/financialSchemas');

const { idempotency } = require('../middleware/idempotency');
const protect = authMiddleware.protect;

router.post('/fiat', protect, idempotency(), validate(fiatWithdrawalSchema), withdrawalController.fiatWithdrawal);
router.post('/crypto', protect, idempotency(), validate(cryptoWithdrawalSchema), withdrawalController.cryptoWithdrawal);

// Real-time withdrawal progress popup — polling fallback for the Socket.IO
// `withdrawal_progress` event. Owner-only; returns a {stage,label,pct} triple.
router.get('/status/:reference', protect, withdrawalController.getWithdrawalStatus);

module.exports = router;
