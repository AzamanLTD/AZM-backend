// routes/vaultYieldRoutes.js
// =============================================================================
// AZAMAN — Vault DeFi Yield Routes (Phase 3)
//
// GET  /api/vaults/yield/strategies              — list available strategies
// POST /api/vaults/:id/yield/enable              — enable yield for a vault
// POST /api/vaults/:id/yield/disable             — disable yield
// POST /api/vaults/:id/yield/compound            — manually compound
// GET  /api/vaults/:id/yield/earnings            — get yield earnings summary
// POST /api/vaults/:id/yield/toggle-auto         — toggle auto-compounding
// =============================================================================

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/vaultYieldController');
const { protect } = require('../middleware/authMiddleware');

router.get('/yield/strategies', protect, ctrl.listStrategies);
router.post('/:id/yield/enable', protect, ctrl.enableYield);
router.post('/:id/yield/disable', protect, ctrl.disableYield);
router.post('/:id/yield/compound', protect, ctrl.compound);
router.get('/:id/yield/earnings', protect, ctrl.getEarnings);
router.post('/:id/yield/toggle-auto', protect, ctrl.toggleAutoCompound);

module.exports = router;
