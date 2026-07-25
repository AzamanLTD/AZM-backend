// routes/savingsRoutes.js
// =============================================================================
// AZAMAN V3 — SAVINGS SYSTEM ROUTES
// Mounted at /api/savings in server.js
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const savingsController = require('../controllers/savingsController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { idempotency } = require('../middleware/idempotency');

// Overview dashboard (read-only — works for banned users)
router.get('/overview', protect, savingsController.getOverview);

// List all goals (read-only)
router.get('/goals', protect, savingsController.listGoals);

// Get single goal with deposit history (read-only)
router.get('/goals/:id', protect, savingsController.getGoal);

// Create a new savings goal (write — ban guarded)
router.post('/goals', protectActive, savingsController.createGoal);

// Deposit into a savings goal (write — ban guarded)
router.post('/goals/:id/deposit', protectActive, idempotency(), savingsController.deposit);

// Withdraw from a savings goal (write — ban guarded)
router.post('/goals/:id/withdraw', protectActive, idempotency(), savingsController.withdraw);

// Pause a savings goal
router.put('/goals/:id/pause', protectActive, savingsController.pauseGoal);

// Resume a paused savings goal
router.put('/goals/:id/resume', protectActive, savingsController.resumeGoal);

module.exports = router;
