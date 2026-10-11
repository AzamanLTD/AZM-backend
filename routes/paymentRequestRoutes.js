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
const { resolvePublicAppOrigin } = require('../src/config/publicAppUrl');

// Fail-closed PRE-CLAIM guard: a LINK create must never reach the
// idempotency authority (or economics) when ANY piece of link configuration
// is unusable. Two independent requirements, both validated BEFORE the
// claim so a refusal leaves no residue:
//
//   1. Share-token key (ENCRYPTION_KEY via fieldCipher) — the persisted
//      replay response must never carry plaintext token material.
//   2. Canonical origin (PUBLIC_APP_URL) — a LINK request needs a
//      server-minted share URL, and the origin must come from validated
//      configuration, never the untrusted Host header. The controller's
//      mintLinkShare() would otherwise throw PUBLIC_APP_URL_UNCONFIGURED
//      AFTER the idempotency claim exists; with releaseOn4xx declared (4xx
//      only), a 5xx refusal RETAINS an IN_PROGRESS claim — and the same-key
//      retry Luis's review found would then get an in-progress conflict even
//      after the operator fixes configuration. Validating the origin here,
//      before the claim, makes the failure leave NO claim residue and NO
//      request row; the operator fixes PUBLIC_APP_URL and the same retry
//      with the preserved key starts clean.
//
// DIRECT creates are unaffected (they need no share URL and no token).
//
// REPLAY EXEMPTION: when a COMMITTED claim already exists for
// (user, endpoint, key), the request is a legitimate replay — the
// middleware re-emits the stored bytes WITHOUT touching crypto or URL
// configuration, so refusing it would break the §r42 byte-identical replay
// contract. Missing configuration must never prevent a replay of an
// already-committed response. Such requests are passed through (the guard
// only refuses NEW work). A read error falls through to refusal: the guard
// fails closed.
async function requireLinkConfig(req, res, next) {
    const mode = String(req.body?.requestMode ?? '').trim().toUpperCase();
    if (mode !== 'LINK') {
        return next(); // DIRECT: no share token, no share URL — unaffected.
    }

    // Gather configuration failures first; refuse only after the replay
    // exemption is checked so a committed operation replays regardless.
    const cryptoOk = isShareCryptoAvailable();
    const origin = resolvePublicAppOrigin();
    if (cryptoOk && origin.ok) {
        return next(); // fully configured — new LINK work may proceed.
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
            return next(); // replay of committed bytes — configuration not required
        }
    } catch {
        // fall through to refusal — fail closed
    }

    if (!cryptoOk) {
        // Deterministic precedence: the token key is the more fundamental
        // failure (no envelope could exist at all); report it first when
        // both are missing, matching the pre-existing L4 contract.
        return res.status(503).json({
            success: false,
            code: 'LINK_SHARE_CRYPTO_UNCONFIGURED',
            message: 'Link request sharing is unavailable because the server share-token key is not configured. Nothing was created.',
        });
    }
    return res.status(503).json({
        success: false,
        code: 'PUBLIC_APP_URL_UNCONFIGURED',
        message: `Link request sharing is unavailable because the server's public app URL is not usable. ${origin.message} Nothing was created.`,
    });
}

// Bounded list: incoming (addressed to me) or outgoing (I created).
router.get('/', protect, ctrl.list);

// Create. Wired claim: committed inside the create transaction.
// The pre-claim LINK configuration guard runs BEFORE the idempotency claim
// so a misconfigured server refuses LINK creates cleanly (no claim, no row)
// while committed replays still pass through.
router.post('/',
    protectActive,
    requireLinkConfig,
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
