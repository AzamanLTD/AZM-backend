// routes/vaultRoutes.js
// =============================================================================
// AZAMAN — VAULT ROUTES  (Master Sprint, 2026-05-27)
//
// All under /api/vaults. Read paths use `protect` so a banned user can
// still review their existing vaults; writes use `protectActive` so a
// frozen account cannot deposit/break.
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/vaultController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { idempotency } = require('../middleware/idempotency');
const { require2FA } = require('../middleware/require2FA');

router.get('/',                  protect,        ctrl.list);
router.post('/',                 protectActive,  ctrl.create);
router.get('/:id',               protect,        ctrl.getDetail);
router.post('/:id/deposit',      protectActive,  idempotency(), ctrl.deposit);
router.post('/:id/auto-rule',    protectActive,  ctrl.setAutoRule);
router.delete('/:id/auto-rule',  protectActive,  ctrl.disableAutoRule);
router.post('/:id/break',        protectActive,  require2FA(), idempotency(), ctrl.breakEarly);
router.get('/:id/receipt',       protect,        ctrl.getReceipt);
router.get('/:id/deposits',      protect,        ctrl.listDeposits);

module.exports = router;
