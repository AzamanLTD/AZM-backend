const express = require('express');
const router = express.Router();
const withdrawalController = require('../controllers/withdrawalController');
const authMiddleware = require('../middleware/authMiddleware');

const protect = authMiddleware.protect;

router.post('/fiat', protect, withdrawalController.fiatWithdrawal);
router.post('/crypto', protect, withdrawalController.cryptoWithdrawal);

module.exports = router;
