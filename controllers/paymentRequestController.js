// controllers/paymentRequestController.js
// =============================================================================
// STANDALONE PAYMENT REQUESTS — controller.
//
// The server-owned "request money" resource behind /api/payment-requests.
// Deliberately separate from the chat-oriented PeerTransfer REQUEST flow:
//   • NO PeerTransfer row is created on this path.
//   • NO DirectMessage is created on this path.
//   • The legacy route POST /api/friends/transfer/request is NOT reused,
//     aliased or redirected (proven by contract tests in
//     __tests__/payment-requests-contract.test.js).
//
// Financial boundaries:
//   • POST / is under the §r42 shared idempotency authority with the claim
//     committed INSIDE the create transaction (the wired pattern, mirroring
//     multi-currency convert): a post-response IN_PROGRESS claim is durable
//     proof the transaction rolled back, so the route declares
//     releaseOn4xx and failurePolicy RELEASE.
//   • Cancel/decline are single-winner conditional updates (CAS on
//     status=PENDING + expiry guard); the claim commits in the SAME
//     transaction as the terminal transition.
//   • There is NO pay/accept-and-pay/PAID transition here: no authoritative
//     per-user GHS settlement rail exists (user balance projection is USDC;
//     GHS exists only as §P.5-D treasury liquidity evidence). Settlement is
//     reported as a blocking dependency instead of being faked.
// =============================================================================

const logger = require('../src/config/logger');
const svc = require('../services/paymentRequestService');

const {
    normalizeAmount,
    resolveExpiry,
    mintLinkToken,
    hashToken,
    buildShareUrl,
    projectStatus,
    toListItem,
    toPublicDto,
    displayNameOf,
    encodeCursor,
    decodeCursor,
    PENDING,
    CANCELLED,
    DECLINED,
    EXPIRED,
} = svc;

// Honest failure helper: typed code + status, message never invented.
const fail = (res, status, code, message) =>
    res.status(status).json({ success: false, code, message });

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment-requests — create a standalone request (DIRECT or LINK)
// ─────────────────────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
    const prisma = req.app.get('prisma');
    // The §r42 durable claim inserted BEFORE this handler ran (wired route:
    // it is committed inside the create transaction below).
    const claim = res.locals?.financialOperation || null;
    const requesterId = req.user.id;

    try {
        const { requestMode, recipientUserId } = req.body;

        // Exact-decimal amount (2dp GHS string). Throws AmountError with a
        // user-honest message; provably pre-economics.
        const amountExact = normalizeAmount(req.body.amount);

        // Currency is fixed to GHS at creation (schema default); a client
        // sending any other value is refused — never silently coerced.
        if (req.body.currency !== 'GHS') {
            return fail(res, 400, 'UNSUPPORTED_CURRENCY',
                'Only GHS payment requests are supported.');
        }

        // Unambiguous mode semantics: exactly one of DIRECT/LINK, and the
        // recipient field matches the mode — never both, never neither.
        if (requestMode !== 'DIRECT' && requestMode !== 'LINK') {
            return fail(res, 400, 'INVALID_REQUEST_MODE',
                'requestMode must be DIRECT or LINK.');
        }

        let recipientId = null;
        if (requestMode === 'DIRECT') {
            if (recipientUserId === undefined || recipientUserId === null ||
                String(recipientUserId).trim() === '') {
                return fail(res, 400, 'RECIPIENT_REQUIRED',
                    'A direct request requires recipientUserId.');
            }
            const parsed = Number.parseInt(String(recipientUserId).trim(), 10);
            if (!Number.isInteger(parsed) || String(parsed) !== String(recipientUserId).trim()) {
                // A Friendship/relationship uuid or any non-numeric account
                // id is refused: recipientUserId is a User account id ONLY.
                return fail(res, 400, 'RECIPIENT_REQUIRED',
                    'recipientUserId must be the recipient\'s Azaman account id.');
            }
            if (parsed === requesterId) {
                return fail(res, 400, 'SELF_REQUEST',
                    'You cannot request money from yourself.');
            }
            const recipient = await prisma.user.findUnique({
                where: { id: parsed },
                select: { id: true, isDeleted: true },
            });
            if (!recipient || recipient.isDeleted) {
                return fail(res, 404, 'RECIPIENT_NOT_FOUND',
                    'That recipient account does not exist.');
            }
            // Authorization: the requester may only request from accounts
            // with an ACCEPTED friendship (either direction). The friendship
            // row's id is never used as an account id here.
            const friendship = await prisma.friendship.findFirst({
                where: {
                    status: 'ACCEPTED',
                    OR: [
                        { requesterId: requesterId, addresseeId: parsed },
                        { requesterId: parsed, addresseeId: requesterId },
                    ],
                },
                select: { id: true },
            });
            if (!friendship) {
                return fail(res, 403, 'NOT_FRIENDS',
                    'You can only request money from accepted Azaman contacts.');
            }
            recipientId = parsed;
        } else if (recipientUserId !== undefined && recipientUserId !== null &&
                   String(recipientUserId).trim() !== '') {
            return fail(res, 400, 'RECIPIENT_NOT_ALLOWED',
                'A link request has no preselected recipient.');
        }

        // Expiry: server-owned policy (documented default 7 days).
        const expiresAt = resolveExpiry();

        // LINK: mint the high-entropy share token now; only its sha256 hash
        // is stored. The share URL needs the validated PUBLIC_APP_URL origin
        // — fail BEFORE any economics if it is unconfigured.
        let token = null;
        let tokenHash = null;
        let shareUrl = null;
        if (requestMode === 'LINK') {
            token = mintLinkToken();
            tokenHash = hashToken(token);
            shareUrl = buildShareUrl(token);
        }

        const created = await prisma.$transaction(async (tx) => {
            const row = await tx.paymentRequest.create({
                data: {
                    requesterId,
                    recipientId,
                    mode: requestMode,
                    status: PENDING,
                    amountExact,
                    currency: 'GHS',
                    tokenHash,
                    expiresAt,
                },
            });

            // The response is fixed HERE (inside the transaction) because the
            // wired claim stores its exact wire bytes as the replay truth.
            const request = {
                id: row.id,
                amount: row.amountExact,
                currency: row.currency,
                status: row.status,
                mode: row.mode,
                createdAt: row.createdAt,
                expiresAt: row.expiresAt,
                shareUrl,
            };

            if (claim) {
                // Commit the durable operation identity WITH the economics.
                // Guarded on IN_PROGRESS so an already-committed row is
                // never overwritten; count!==1 rolls the whole create back.
                const committed = await tx.financialOperation.updateMany({
                    where: { id: claim.id, status: 'IN_PROGRESS' },
                    data: {
                        status: 'COMMITTED',
                        // Must equal the wire status below (201) — the replay
                        // re-emits BOTH stored bytes and stored status code.
                        statusCode: 201,
                        responseBody: JSON.stringify({ success: true, data: { request } }),
                    },
                });
                if (committed.count !== 1) {
                    const err = new Error('Idempotency operation state conflict.');
                    err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                    throw err;
                }
            }
            return { row, request };
        });

        // Post-commit, best-effort: notify the DIRECT recipient through the
        // existing notification pipeline (DB + socket + FCM inside the
        // service). A replay never reaches this code (the committed claim
        // replays stored bytes), so idempotent requests never notify twice.
        if (recipientId !== null) {
            try {
                const notificationService = req.app.get('notificationService');
                if (notificationService) {
                    const requester = await prisma.user.findUnique({
                        where: { id: requesterId },
                        select: { displayName: true, username: true },
                    });
                    await notificationService.sendNotification({
                        userId: recipientId,
                        title: 'New payment request',
                        body: `${displayNameOf(requester) || 'An Azaman contact'} requested GH₵ ${created.row.amountExact} from you.`,
                        category: 'MONEY',
                        actionPayload: {
                            route: '/payment-requests',
                            action: 'OPEN_PAYMENT_REQUESTS',
                            requestId: created.row.id,
                        },
                    });
                }
            } catch (notifyErr) {
                // The request itself is committed; a notification failure must
                // not fail the committed operation (replays would then diverge
                // from the stored 200).
                logger.error({ err: notifyErr, requestId: created.row.id },
                    '[payment-requests] recipient notification failed (request committed)');
            }
        }

        return res.status(201).json({ success: true, data: { request: created.request } });
    } catch (err) {
        if (err instanceof svc.AmountError) {
            return fail(res, 400, 'INVALID_AMOUNT', err.message);
        }
        if (err?.code === 'PUBLIC_APP_URL_UNCONFIGURED') {
            return fail(res, 503, err.code, err.message);
        }
        if (err?.code === 'IDEMPOTENCY_STATE_CONFLICT') {
            return fail(res, 409, err.code, err.message);
        }
        logger.error({ err }, '[payment-requests] create failed');
        return fail(res, 500, 'PAYMENT_REQUEST_CREATE_FAILED',
            'The payment request could not be created. Please try again.');
    }
};
exports.create.openapi = {
    summary: 'Create a standalone payment request (DIRECT or LINK)',
    description: 'Creates a server-owned money request. DIRECT requires an accepted friendship and exactly one recipientUserId (a User account id). LINK returns a canonical server-issued shareUrl. Amount is an exact 2-dp GHS decimal string and immutable. Requires an Idempotency-Key header.',
    tags: ['payment-requests'],
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment-requests?direction=INCOMING|OUTGOING — bounded list
// ─────────────────────────────────────────────────────────────────────────────
exports.list = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const { direction } = req.query;
        if (direction !== 'INCOMING' && direction !== 'OUTGOING') {
            return fail(res, 400, 'INVALID_DIRECTION',
                'direction must be INCOMING or OUTGOING.');
        }

        const limitRaw = Number.parseInt(String(req.query.limit ?? '20'), 10);
        const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 50
            ? limitRaw
            : 20;

        const where = direction === 'INCOMING'
            ? { recipientId: userId }
            : { requesterId: userId };

        // Stable cursor pagination (createdAt desc, id desc). Bounded: the
        // fetch is always limit+1 rows, never an unbounded query.
        const cursor = req.query.cursor ? decodeCursor(String(req.query.cursor)) : null;
        if (req.query.cursor && !cursor) {
            return fail(res, 400, 'INVALID_CURSOR', 'The pagination cursor is malformed.');
        }
        if (cursor) {
            where.OR = [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ];
        }

        const rows = await prisma.paymentRequest.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: {
                id: true, requesterId: true, recipientId: true, mode: true,
                status: true, amountExact: true, currency: true,
                expiresAt: true, resolvedAt: true, createdAt: true,
                requester: { select: { displayName: true, username: true } },
                recipient: { select: { displayName: true, username: true } },
            },
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const requests = page.map((row) =>
            toListItem(row, { viewerIsRequester: direction === 'OUTGOING' }));
        const last = page[page.length - 1];

        return res.status(200).json({
            success: true,
            data: {
                requests,
                nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
            },
        });
    } catch (err) {
        logger.error({ err }, '[payment-requests] list failed');
        return fail(res, 500, 'PAYMENT_REQUEST_LIST_FAILED',
            'Payment requests could not be loaded. Please try again.');
    }
};
exports.list.openapi = {
    summary: 'List payment requests (incoming or outgoing)',
    description: 'INCOMING returns requests addressed to the authenticated user; OUTGOING returns requests they created. Bounded cursor pagination, stable ordering. Never returns token material.',
    tags: ['payment-requests'],
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment-requests/public/:token — unauthenticated link details
// ─────────────────────────────────────────────────────────────────────────────
exports.publicDetail = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const token = String(req.params.token || '');
        if (!token || token.length > 256) {
            return fail(res, 404, 'PAYMENT_REQUEST_NOT_FOUND',
                'This payment request does not exist.');
        }

        // The token is looked up ONLY via its sha256 hash; the raw token is
        // never stored, compared, logged or echoed.
        const row = await prisma.paymentRequest.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
                id: true, mode: true, status: true, amountExact: true,
                currency: true, expiresAt: true, createdAt: true,
                requester: { select: { displayName: true, username: true } },
            },
        });

        if (!row) {
            return fail(res, 404, 'PAYMENT_REQUEST_NOT_FOUND',
                'This payment request does not exist or is no longer available.');
        }

        // Honest, predictable expiry: the link is dead once the request is
        // past its server-enforced expiry, regardless of stored status.
        if (projectStatus(row) === EXPIRED) {
            return fail(res, 410, 'PAYMENT_REQUEST_EXPIRED',
                'This payment request has expired.');
        }

        return res.status(200).json({ success: true, data: { request: toPublicDto(row) } });
    } catch (err) {
        logger.error({ err }, '[payment-requests] public detail failed');
        return fail(res, 500, 'PAYMENT_REQUEST_UNAVAILABLE',
            'This payment request is unavailable. Try opening the link again.');
    }
};
exports.publicDetail.openapi = {
    summary: 'Public payment-request link details (unauthenticated)',
    description: 'Minimal DTO for the /request/:token landing page: amount, currency, status, expiry, requester display info. No email, phone, recipient identity or token material. Expired links return 410.',
    tags: ['payment-requests'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared terminal-transition engine (cancel / decline)
//
// Single-winner contract: the transition is a conditional updateMany on
// (id, owner, status=PENDING, expiresAt > now). Under concurrency exactly one
// writer matches; the loser's count=0 rolls back the whole transaction (claim
// included) and converges by re-reading the committed row. The claim commits
// in the SAME transaction as the transition (wired pattern).
// ─────────────────────────────────────────────────────────────────────────────
async function resolveTerminal(req, res, { action, ownerField, terminalStatus, eligibility }) {
    const prisma = req.app.get('prisma');
    const claim = res.locals?.financialOperation || null;
    const userId = req.user.id;
    const id = String(req.params.id || '');

    try {
        // Pre-read for HONEST error messages (never for authorization —
        // authorization is enforced by the conditional update itself).
        const existing = await prisma.paymentRequest.findUnique({
            where: { id },
            select: { id: true, requesterId: true, recipientId: true, mode: true, status: true, expiresAt: true },
        });

        if (!existing) {
            return fail(res, 404, 'PAYMENT_REQUEST_NOT_FOUND',
                'This payment request does not exist.');
        }
        if (existing[ownerField] !== userId) {
            return fail(res, 403, 'NOT_AUTHORIZED',
                action === 'cancel'
                    ? 'Only the requester can cancel this payment request.'
                    : 'Only the intended recipient can decline this payment request.');
        }
        if (eligibility && !eligibility(existing)) {
            return fail(res, 403, 'NOT_AUTHORIZED',
                'Link requests have no recipient to decline them.');
        }
        const projected = projectStatus(existing);
        if (projected === EXPIRED) {
            return fail(res, 409, 'PAYMENT_REQUEST_EXPIRED',
                'This payment request has already expired.');
        }
        if (existing.status !== PENDING) {
            return fail(res, 409, 'PAYMENT_REQUEST_ALREADY_RESOLVED',
                `This payment request is already ${existing.status}.`);
        }

        const now = new Date();
        const result = await prisma.$transaction(async (tx) => {
            // THE single-winner claim. Conditional on PENDING and unexpired:
            // a concurrent cancel-vs-decline (or double-cancel) leaves
            // exactly one winner — PostgreSQL row-level serialization.
            const won = await tx.paymentRequest.updateMany({
                where: {
                    id,
                    [ownerField]: userId,
                    status: PENDING,
                    expiresAt: { gt: now },
                },
                data: { status: terminalStatus, resolvedAt: now },
            });
            if (won.count !== 1) {
                const err = new Error('terminal-transition-conflict');
                err.code = 'TERMINAL_TRANSITION_CONFLICT';
                throw err;
            }
            const row = await tx.paymentRequest.findUnique({
                where: { id },
                include: {
                    requester: { select: { displayName: true, username: true } },
                    recipient: { select: { displayName: true, username: true } },
                },
            });
            const request = toListItem(row, {
                viewerIsRequester: action === 'cancel',
            });
            if (claim) {
                const committed = await tx.financialOperation.updateMany({
                    where: { id: claim.id, status: 'IN_PROGRESS' },
                    data: {
                        status: 'COMMITTED',
                        statusCode: 200,
                        responseBody: JSON.stringify({ success: true, data: { request } }),
                    },
                });
                if (committed.count !== 1) {
                    const err = new Error('Idempotency operation state conflict.');
                    err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                    throw err;
                }
            }
            return { row, request };
        });

        return res.status(200).json({ success: true, data: { request: result.request } });
    } catch (err) {
        if (err?.code === 'TERMINAL_TRANSITION_CONFLICT') {
            // Converge honestly: report the committed state, never guess.
            const committed = await prisma.paymentRequest.findUnique({
                where: { id },
                select: { status: true, expiresAt: true },
            }).catch(() => null);
            const status = committed ? projectStatus(committed) : PENDING;
            return fail(res, 409, 'PAYMENT_REQUEST_ALREADY_RESOLVED',
                `This payment request is already ${status}.`);
        }
        if (err?.code === 'IDEMPOTENCY_STATE_CONFLICT') {
            return fail(res, 409, err.code, err.message);
        }
        logger.error({ err, action }, '[payment-requests] terminal transition failed');
        return fail(res, 500, 'PAYMENT_REQUEST_RESOLVE_FAILED',
            'The payment request could not be updated. Please try again.');
    }
}

// POST /api/payment-requests/:id/cancel — requester only
exports.cancel = async (req, res) => resolveTerminal(req, res, {
    action: 'cancel',
    ownerField: 'requesterId',
    terminalStatus: CANCELLED,
});
exports.cancel.openapi = {
    summary: 'Cancel a payment request (requester only)',
    description: 'Single-winner terminal transition; concurrent or repeated cancels converge on the committed state. Expired requests cannot be cancelled. Requires an Idempotency-Key header.',
    tags: ['payment-requests'],
};

// POST /api/payment-requests/:id/decline — designated recipient, DIRECT only
exports.decline = async (req, res) => resolveTerminal(req, res, {
    action: 'decline',
    ownerField: 'recipientId',
    terminalStatus: DECLINED,
    eligibility: (row) => row.mode === 'DIRECT' && row.recipientId !== null,
});
exports.decline.openapi = {
    summary: 'Decline a payment request (designated recipient, DIRECT only)',
    description: 'Only the single intended recipient of a DIRECT request may decline. LINK requests have no preselected payer and cannot be declined. Requires an Idempotency-Key header.',
    tags: ['payment-requests'],
};
