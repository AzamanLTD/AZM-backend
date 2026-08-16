// routes/fraudRoutes.js
// =============================================================================
// Fraud Detection Admin Routes
//
//   GET  /api/fraud/rules          — List all fraud detection rules
//   GET  /api/fraud/assessments    — List recent fraud assessments (paginated)
//   GET  /api/fraud/assessments/blocked — Only blocked transactions
//   POST /api/fraud/evaluate       — Manually evaluate a transaction (testing)
// =============================================================================

const express = require('express');
const router = express.Router();
const fraudService = require('../services/fraudDetectionService');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../src/config/logger');

const { protect, adminOnly } = authMiddleware;

// ── List all rules ─────────────────────────────────────────────────────────────
router.get('/rules', protect, adminOnly, async (req, res) => {
  const rules = fraudService.getRules();
  return res.json({ success: true, data: rules });
});

// ── List assessments (paginated) ───────────────────────────────────────────────
router.get('/assessments', protect, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = parseInt(req.query.skip) || 0;
    const onlyBlocked = req.query.blocked === 'true';

    const { assessments, total } = await fraudService.getAssessments({ limit, skip, onlyBlocked });

    return res.json({
      success: true,
      data: assessments,
      pagination: { total, limit, skip, hasMore: skip + assessments.length < total },
    });
  } catch (err) {
    logger.error({ err: err.message }, '[fraud] List assessments failed');
    return res.status(500).json({ success: false, message: 'Failed to list assessments.' });
  }
});

// ── Manually evaluate a transaction (for testing) ─────────────────────────────
router.post('/evaluate', protect, adminOnly, async (req, res) => {
  try {
    const { userId, type, amount, accountAgeHours } = req.body;

    if (!userId || !type) {
      return res.status(400).json({ success: false, message: 'userId and type are required.' });
    }

    const result = await fraudService.evaluate({
      userId: parseInt(userId),
      type,
      amount: parseFloat(amount) || 0,
      accountAgeHours: accountAgeHours !== undefined ? parseFloat(accountAgeHours) : undefined,
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error({ err: err.message }, '[fraud] Manual evaluate failed');
    return res.status(500).json({ success: false, message: 'Evaluation failed.' });
  }
});

module.exports = router;
