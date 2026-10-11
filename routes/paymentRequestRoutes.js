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
//     and never exposes token material — the path parameter is the raw
//     token's AES-256-GCM envelope, unwrapped (AEAD-verified) and resolved
//     via sha256(raw). The raw token is never stored anywhere in plaintext:
//     only its sha256 hash (PaymentRequest.tokenHash) and its AEAD envelope
//     inside the persisted create response (FinancialOperation.responseBody,
//     ciphertext at rest) exist in durable stores.
// =============================================================================

const router = require('express').Router();
const ctrl = require('../controllers/paymentRequestController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { idempotency } = require('../middleware/idempotency');
const { validate } = require('../middleware/validate');
const { createPaymentRequestSchema } = require('../services/validation/financialSchemas');
const { isShareCryptoAvailable } = require('../services/crypto/shareToken');

// Fail-closed PRE-CLAIM guard: a LINK create must never reach the
// idempotency authority (or economics) when the share-token key is unusable
// — the persisted replay response would otherwise have to carry plaintext
// token material, or the create would fail post-claim. DIRECT creates are
// unaffected (they need no share token). Refusal leaves NO claim residue
// and NO request row; the operator fixes ENCRYPTION_KEY and the same retry
// starts clean.
//
// REPLAY EXEMPTION: when a COMMITTED claim already exists for
// (user, endpoint, key), the request is a legitimate replay — the
// middleware re-emits the stored ciphertext bytes WITHOUT touching crypto,
// so refusing it would break the §r42 replay contract. Such requests are
// passed through (the guard only refuses NEW work). A read error falls
// through to refusal: the guard fails closed.
async function requireLinkCrypto(req, res, next) {
    const mode = String(req.body?.requestMode ?? '').trim().toUpperCase();
    if (mode !== 'LINK' || isShareCryptoAvailable()) {
        return next();
    }
    try {
        const prisma = req.app.get('prisma');
        const key = req.headers['idempotency-key'];
        const committed = await prisma.financialOperation.findFirst({
            where: {
                userId: req.user.id,
                endpoint: 'POST /api/payment-requests/', // §r42 canonical mount pattern
                key,
                status: 'COMMITTED',
            },
            select: { id: true },
        });
        if (committed) {
            return next(); // replay of committed bytes — crypto not required
        }
    } catch {
        // fall through to refusal — fail closed
    }
    return res.status(503).json({
        success: false,
        code: 'LINK_SHARE_CRYPTO_UNCONFIGURED',
        message: 'Link request sharing is unavailable because the server share-token key is not configured. Nothing was created.',
    });
}

// Bounded list: incoming (addressed to me) or outgoing (I created).
router.get('/', protect, ctrl.list);

// Create. Wired claim: committed inside the create transaction.
// The pre-claim crypto guard runs BEFORE the idempotency claim so a
// misconfigured server refuses LINK creates cleanly (no claim, no row).
router.post('/',
    protectActive,
    requireLinkCrypto,
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
