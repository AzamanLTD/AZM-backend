const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/marketplaceFinanceController');

router.get('/stats',           protect, ctrl.getStats);
router.get('/transactions',    protect, ctrl.getTransactions);

module.exports = router;
