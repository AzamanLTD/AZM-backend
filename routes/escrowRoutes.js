// routes/escrowRoutes.js
// =============================================================================
// AZAMAN — SMART ESCROW ROUTES (2026-06-14)
// Mounted at /api/escrow. Financial actions use protectActive (ban guard);
// pure reads/term edits use protect.
// =============================================================================

const router = require('express').Router();
const ctrl = require('../controllers/escrowController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

router.get('/ticket/:ticketId', protect, ctrl.getEscrowForTicket);
router.post('/fund', protectActive, ctrl.fundEscrow);
router.post('/satisfy', protectActive, ctrl.markSatisfied);
router.post('/dispute', protectActive, ctrl.raiseDispute);
router.post('/update-terms', protect, ctrl.updateTerms);
router.post('/cancel', protectActive, ctrl.cancelEscrow);

module.exports = router;
