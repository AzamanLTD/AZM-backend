// routes/roundUpRoutes.js
// =============================================================================
// AZAMAN — Round-Up Savings Routes (Phase 3)
// Mounted at /api/round-up
// =============================================================================

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/roundUpController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, ctrl.getSettings);
router.put('/', protect, ctrl.updateSettings);
router.post('/process', protect, ctrl.processRoundUp);
router.get('/history', protect, ctrl.getHistory);

module.exports = router;
