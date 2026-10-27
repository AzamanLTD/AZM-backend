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
const { require2FA } = require('../middleware/require2FA');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { validate } = require('../middleware/validate');
const { fundEscrowSchema, raiseDisputeSchema } = require('../services/validation/financialSchemas');

router.get('/ticket/:ticketId', protect, ctrl.getEscrowForTicket);
// §r42.1 wired: the claim commits INSIDE the funding $transaction, so an
// IN_PROGRESS claim after a 4xx is durable proof of rollback — the key is
// safely releasable (releaseOn4xx). 5xx stays RETAIN (default): a post-
// commit failure must never re-arm a funded escrow.
router.post('/fund', protectActive, require2FA(), idempotency({ releaseOn4xx: true }), validate(fundEscrowSchema), ctrl.fundEscrow);
router.post('/satisfy', protectActive, idempotency(), ctrl.markSatisfied);
router.post('/dispute', protectActive, idempotency(), validate(raiseDisputeSchema), ctrl.raiseDispute);
router.post('/update-terms', protect, ctrl.updateTerms);
router.post('/cancel', protectActive, idempotency(), ctrl.cancelEscrow);

module.exports = router;
