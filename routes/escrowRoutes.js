// routes/escrowRoutes.js
// =============================================================================
// AZAMAN — SMART ESCROW ROUTES (2026-06-14)
// Mounted at /api/escrow. Financial actions use protectActive (ban guard);
// pure reads/term edits use protect.
// =============================================================================

const logger = require('../src/config/logger');
const router = require('express').Router();
const ctrl = require('../controllers/escrowController');
const { protect } = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { validate } = require('../middleware/validate');
const { fundEscrowSchema, raiseDisputeSchema } = require('../services/validation/financialSchemas');

router.get('/ticket/:ticketId', protect, ctrl.getEscrowForTicket);
router.post('/fund', protectActive, idempotency(), validate(fundEscrowSchema), ctrl.fundEscrow);
router.post('/satisfy', protectActive, idempotency(), ctrl.markSatisfied);
router.post('/dispute', protectActive, idempotency(), validate(raiseDisputeSchema), ctrl.raiseDispute);
router.post('/update-terms', protect, ctrl.updateTerms);
router.post('/cancel', protectActive, idempotency(), ctrl.cancelEscrow);

module.exports = router;
