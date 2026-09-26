// routes/creditScoreRoutes.js
// =============================================================================
// AZAMAN V3 — Credit Score Routes (Phase 5)
// =============================================================================

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { isAdmin } = require('../middleware/adminMiddleware');
const creditScoreController = require('../controllers/creditScoreController');

const protect = authMiddleware.protect;

// User endpoints
router.get('/',        protect, creditScoreController.getCreditScore);
router.get('/history', protect, creditScoreController.getCreditScoreHistory);
router.post('/refresh', protect, creditScoreController.refreshCreditScore);
router.get('/factors',  protect, creditScoreController.getCreditFactors);

// Admin endpoint
router.get('/user/:userId', protect, isAdmin, creditScoreController.getUserCreditScore);

module.exports = router;
