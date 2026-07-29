const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const porController = require('../controllers/proofOfReservesController');

const protect = authMiddleware.protect;

// Public endpoints (no auth)
router.get('/',         porController.getReserveSnapshot);
router.get('/history',  porController.getReserveHistory);

// Authenticated endpoint
router.get('/verify',   protect, porController.verifyBalanceInclusion);

module.exports = router;
