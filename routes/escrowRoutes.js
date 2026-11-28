// routes/escrowRoutes.js
// =============================================================================
// AZAMAN — SMART ESCROW ROUTES (2026-06-14)
// Mounted at /api/escrow. Financial actions use protectActive (ban guard);
// pure reads/term edits use protect.
// =============================================================================

const { requireActionStepUp, whenStepUpEnforced, exclusiveSecondFactor } = require('../middleware/requireActionStepUp');
const logger = require('../src/config/logger');
const { requireKyc } = require('../middleware/requireKyc');
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
// §WP-H G — idempotency BEFORE the action-bound gate (a committed retry
// replays without a new grant), the grant spent INSIDE the economic
// transaction by the controller, and require2FA / the grant exclusive.
const escrowFundStepUp = whenStepUpEnforced(requireActionStepUp({
    actionType: 'ESCROW_FUND',
    routeScope: 'POST /api/escrow/fund',
    currency: () => 'USDC',
    amount: () => null, // the amount is the escrow row's, bound through the resource
    resource: (req) => (req.body && req.body.escrowId) || null,
}));
// Satisfaction can release the principal to the payee, so it now carries a
// second factor in both enforcement modes (it previously had none).
const escrowSatisfyStepUp = whenStepUpEnforced(requireActionStepUp({
    actionType: 'ESCROW_RELEASE',
    routeScope: 'POST /api/escrow/satisfy',
    currency: () => 'USDC',
    amount: () => null,
    resource: (req) => (req.body && req.body.escrowId) || null,
}));
router.post('/fund', protectActive, requireKyc('pay'), exclusiveSecondFactor(require2FA), idempotency({ releaseOn4xx: true }), escrowFundStepUp, validate(fundEscrowSchema), ctrl.fundEscrow);
router.post('/satisfy', protectActive, exclusiveSecondFactor(require2FA), idempotency(), escrowSatisfyStepUp, ctrl.markSatisfied);
router.post('/dispute', protectActive, idempotency(), validate(raiseDisputeSchema), ctrl.raiseDispute);
router.post('/update-terms', protect, ctrl.updateTerms);
router.post('/cancel', protectActive, idempotency(), ctrl.cancelEscrow);

module.exports = router;
