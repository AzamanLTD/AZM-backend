const express = require('express');
const router = express.Router();
const withdrawalController = require('../controllers/withdrawalController');
const authMiddleware = require('../middleware/authMiddleware');

const protect = authMiddleware.protect;

router.post('/fiat', protect, withdrawalController.fiatWithdrawal);
router.post('/crypto', protect, withdrawalController.cryptoWithdrawal);

// Real-time withdrawal progress popup — polling fallback for the Socket.IO
// `withdrawal_progress` event. Owner-only; returns a {stage,label,pct} triple.
router.get('/status/:reference', protect, withdrawalController.getWithdrawalStatus);

module.exports = router;
