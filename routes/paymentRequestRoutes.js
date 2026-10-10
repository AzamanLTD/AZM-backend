// routes/paymentRequestRoutes.js
// =============================================================================
// AZAMAN — STANDALONE PAYMENT REQUEST ROUTES
// Mounted at /api/payment-requests. This is the server-owned request
// resource (Receive/Request UX) — deliberately separate from the chat
// PeerTransfer REQUEST flow; no PeerTransfer row or DirectMessage is ever
// created on this path.
//
// Authority layout (mirrors routes/escrowRoutes.js):
//   • POST /create + terminal transitions use protectActive (ban guard);
//   • every mutation is under the §r42 shared idempotency authority:
//     - POST / declares releaseOn4xx because the claim commits INSIDE the
//       create transaction (wired pattern) — a post-response IN_PROGRESS
//       claim is durable proof of rollback;
//     - cancel/decline commit the claim inside the SAME transaction as the
//       single-winner terminal transition, so they declare releaseOn4xx too;
//   • list is a pure authenticated read (protect);
//   • GET /public/:token is UNAUTHENTICATED by contract (link landing page)
//     and never exposes token material — the path parameter is hashed and
//     the raw token is never stored anywhere.
// =============================================================================

const router = require('express').Router();
const ctrl = require('../controllers/paymentRequestController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { idempotency } = require('../middleware/idempotency');
const { validate } = require('../middleware/validate');
const { createPaymentRequestSchema } = require('../services/validation/financialSchemas');

// Bounded list: incoming (addressed to me) or outgoing (I created).
router.get('/', protect, ctrl.list);

// Create. Wired claim: committed inside the create transaction.
router.post('/',
    protectActive,
    idempotency({ releaseOn4xx: true }),
    validate(createPaymentRequestSchema),
    ctrl.create);

// Public landing details for /request/:token. Unauthenticated by contract;
// the controller returns only the minimal public DTO and enforces expiry.
router.get('/public/:token', ctrl.publicDetail);

// Requester-only cancellation. Single-winner conditional update.
router.post('/:id/cancel',
    protectActive,
    idempotency({ releaseOn4xx: true }),
    ctrl.cancel);

// Recipient-only decline (DIRECT requests only).
router.post('/:id/decline',
    protectActive,
    idempotency({ releaseOn4xx: true }),
    ctrl.decline);

module.exports = router;
