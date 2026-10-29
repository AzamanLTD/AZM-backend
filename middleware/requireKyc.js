// middleware/requireKyc.js
// =============================================================================
// KYC enforcement at the FINANCIAL ACTION BOUNDARY.
//
// P9 of the card-identity program: identity verification is deferred until a
// user actually tries to move money. Until this middleware existed, NOTHING in
// the backend read `User.kycStatus` — GET /api/kyc/status and the Dojah flow
// were reachable and correct, but no financial route consulted the result, so
// an unverified account could withdraw, trade, join a susu and send P2P money
// exactly like a verified one. The screens in the app were, in the precise
// sense, decorative.
//
// WHY THE DB AND NOT THE TOKEN: `protect` sets `req.user` to the decoded JWT
// claims. A verification performed after the token was minted would not appear
// there until the token was refreshed, so a just-verified user would be refused
// and a just-revoked one would still pass. The verdict has to come from the row.
//
// FAIL CLOSED: if the lookup fails we return 503 rather than letting the
// action through, matching `protect`'s live-user lookup.
//
// SCOPE IS CONFIGURATION, NOT CODE: the set of gated actions comes from
// `KYC_GATED_ACTIONS` (comma separated, case-insensitive). The default is
// `withdraw` — the one action that is unambiguously outgoing cash — so
// deploying this does not silently change trading, susu or P2P behaviour.
// Widening the scope to `withdraw,trade,susu,p2p` is an env change that needs
// no redeploy of new code, and is reversible the same way.
//
// Usage:
//   router.post('/fiat', protect, requireKyc('withdraw'), ...);
//
// Placement matters: mount this AFTER `protect` (it needs req.user) and BEFORE
// `require2FA()` and `idempotency()`, so a refused request never consumes an
// idempotency key and never asks the user for a 2FA code it cannot honour.
// =============================================================================

const logger = require('../src/config/logger');

const DEFAULT_GATED_ACTIONS = 'withdraw';

/**
 * The gated action names, parsed per call so a changed env var takes effect
 * without a process restart dance in tests.
 * @returns {Set<string>}
 */
function gatedActions() {
    const raw = process.env.KYC_GATED_ACTIONS;
    const list = (typeof raw === 'string' && raw.trim().length > 0)
        ? raw
        : DEFAULT_GATED_ACTIONS;
    return new Set(
        list
            .split(',')
            .map((a) => a.trim().toLowerCase())
            .filter((a) => a.length > 0),
    );
}

/**
 * Honest, status-specific copy. The client is expected to route on `code` and
 * `kycStatus`; the message exists so an API consumer that only reads
 * `message` still tells the user the truth.
 */
function refusalFor(kycStatus, action) {
    switch (kycStatus) {
        case 'PENDING':
            return {
                message:
                    'Your identity check is still under review. We will unlock '
                    + `${action} as soon as it clears.`,
                code: 'KYC_PENDING',
                retryable: false,
            };
        case 'REJECTED':
            return {
                message:
                    'Your identity check was rejected. Resubmit your documents '
                    + `in the app to unlock ${action}.`,
                code: 'KYC_REJECTED',
                retryable: false,
            };
        case 'VERIFIED':
            // Unreachable: VERIFIED never reaches refusalFor.
            return { message: 'Identity verified.', code: 'KYC_VERIFIED', retryable: false };
        case 'UNVERIFIED':
        default:
            return {
                message: `Verify your identity to ${action}. It takes a few minutes.`,
                code: 'KYC_REQUIRED',
                retryable: false,
            };
    }
}

/**
 * @param {string} action - the gated action this route performs, e.g. 'withdraw'
 */
function requireKyc(action) {
    const actionName = String(action || '').toLowerCase();

    return async function kycGate(req, res, next) {
        if (!gatedActions().has(actionName)) {
            // Not in the configured scope: behave exactly as before.
            return next();
        }

        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: 'Not authorized: User not authenticated.',
            });
        }

        let liveUser;
        try {
            const prisma = req.app.get('prisma');
            liveUser = await prisma.user.findUnique({
                where: { id: req.user.id },
                select: { kycStatus: true, role: true, isDeleted: true },
            });
        } catch (err) {
            logger.error({ err }, '[requireKyc] identity lookup failed');
            return res.status(503).json({
                success: false,
                message: 'Identity check unavailable. Try again.',
            });
        }

        if (!liveUser || liveUser.isDeleted) {
            return res.status(401).json({
                success: false,
                message: 'Not authorized: User no longer exists.',
                code: 'USER_GONE',
            });
        }

        // Operators must be able to run support and refund paths even when a
        // user's documents are outstanding; admin authority is audited
        // elsewhere, and this middleware is not an authorisation boundary.
        if (liveUser.role === 'ADMIN') {
            return next();
        }

        const status = liveUser.kycStatus || 'UNVERIFIED';
        if (status === 'VERIFIED') {
            return next();
        }

        const refusal = refusalFor(status, actionName);
        logger.info(
            { userId: req.user.id, action: actionName, kycStatus: status },
            '[requireKyc] refused — identity not verified',
        );
        return res.status(403).json({
            success: false,
            message: refusal.message,
            code: refusal.code,
            kycStatus: status,
            requiredFor: actionName,
            retryable: refusal.retryable,
        });
    };
}

module.exports = { requireKyc, gatedActions, DEFAULT_GATED_ACTIONS };
