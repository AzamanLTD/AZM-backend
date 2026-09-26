// middleware/authMiddleware.js
// =============================================================================
// AZAMAN V3 — AUTH MIDDLEWARE (Production-Hardened)
//
// Phase K — token-version validation
// =============================================================================
//
// SECURITY FIXES:
//   - Removed JWT_SECRET fallback (CRITICAL-2)
//   - JWT_SECRET MUST be set via environment variable
//
// Phase K (token-version) addition:
//   - Access JWTs issued from this Phase forward carry a `tokenVersion`
//     claim that mirrors User.tokenVersion at the moment of signing.
//     `protect` looks up the live user row and rejects the request if
//     the live tokenVersion exceeds the claim — i.e., the user's
//     privileges changed (role flip, password change, forced logout)
//     since this token was minted, and the client should refresh.
//
//   - Backwards compat: tokens minted *before* Phase K carry no
//     `tokenVersion` claim. We treat a missing claim as 0. As long as
//     the user's live tokenVersion is still 0 (default), pre-Phase
//     tokens keep working until they expire on their own. The moment
//     a privilege change bumps the live counter, those legacy tokens
//     are rejected — which is the correct behaviour.
//
//   - The lookup is indexed (User.id PK), so the cost is one fast
//     `SELECT tokenVersion, banStatus FROM "User" WHERE id = $1` per
//     authenticated request. We can layer a 30-second LRU cache here in
//     a follow-up if the workload demands it; for now correctness over
//     cleverness.
// =============================================================================

const logger = require('../src/config/logger');
const jwt = require('jsonwebtoken');

// CRITICAL-2: No fallback. If JWT_SECRET is missing, authController.js will
// have already crashed the process at import time.
const JWT_SECRET = process.env.JWT_SECRET;

// Sentinel. When set to '1' (e.g., during deployment cutover), `protect`
// skips the live-tokenVersion check (only) and trusts the JWT's claim
// alone for tokenVersion. The `USER_GONE` and `BANNED` lightweight
// checks remain ENABLED so a deleted/banned user can't keep acting via
// a still-valid JWT during the cutover. Useful for staged rollout when
// the migration is being applied: turn it on, deploy the migration,
// run the migration, turn it back off. Should never be '1' in
// steady-state production.
const SKIP_TOKEN_VERSION_CHECK = process.env.AUTH_SKIP_TOKEN_VERSION_CHECK === '1';

// --- 1. BASIC PROTECTION (Check if logged in) ---
const protect = async (req, res, next) => {
    if (!(req.headers.authorization && req.headers.authorization.startsWith('Bearer'))) {
        return res.status(401).json({
            success: false,
            message: "Not authorized: No Bearer token found in Authorization header."
        });
    }

    const token = req.headers.authorization.split(' ')[1];
    if (!token) {
        return res.status(401).json({
            success: false,
            message: "Not authorized: Token not found in Bearer header."
        });
    }

    if (!JWT_SECRET) {
        logger.error('[authMiddleware] FATAL: JWT_SECRET is not configured.');
        return res.status(500).json({
            success: false,
            message: "Server configuration error."
        });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: "Not authorized: Token has expired.",
                code: 'TOKEN_EXPIRED', // Phase K — clients can detect this and POST /auth/refresh
            });
        } else if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: "Not authorized: Invalid token."
            });
        }
        return res.status(401).json({
            success: false,
            message: "Not authorized: Token verification failed."
        });
    }

    if (!decoded || !decoded.id) {
        return res.status(401).json({
            success: false,
            message: "Not authorized: Invalid token structure."
        });
    }

    // ── Phase K: live-user check (USER_GONE / BANNED / TOKEN_STALE) ────
    //
    // This is the single DB round-trip per request. If perf becomes an
    // issue, layer a small LRU here keyed on userId with a 30s TTL —
    // role flips are rare, and a 30s window of staleness on privilege
    // changes is acceptable.
    //
    // The USER_GONE and BANNED branches always run. Only the
    // tokenVersion comparison is skippable via the cutover sentinel —
    // we never want a deleted or banned user to keep acting just
    // because the operator flipped a flag.
    const prisma = req.app.get('prisma');
    try {
        const liveUser = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { tokenVersion: true, banStatus: true, isDeleted: true },
        });

        if (!liveUser || liveUser.isDeleted) {
            return res.status(401).json({
                success: false,
                message: "Not authorized: User no longer exists.",
                code: 'USER_GONE',
            });
        }

        // Active ban? Block the request — the JWT might still be valid
        // signing-wise but the account is no longer allowed to act.
        // This is a minimal hot-path check; the dedicated
        // banGuardMiddleware does fuller work for chat/trade endpoints.
        if (liveUser.banStatus && liveUser.banStatus !== 'ACTIVE') {
            return res.status(403).json({
                success: false,
                message: "Account is banned.",
                code: 'BANNED',
            });
        }

        if (!SKIP_TOKEN_VERSION_CHECK) {
            // Pre-Phase-K tokens have no tokenVersion claim. Coerce to 0.
            const claimVersion = typeof decoded.tokenVersion === 'number'
                ? decoded.tokenVersion
                : 0;

            if (liveUser.tokenVersion > claimVersion) {
                return res.status(401).json({
                    success: false,
                    message: "Not authorized: Token superseded by a newer credential.",
                    code: 'TOKEN_STALE',
                });
            }
        }
    } catch (dbErr) {
        logger.error({ err: dbErr }, '[authMiddleware] live-user lookup failed');
        // Fail closed: if we can't verify the live state, refuse the
        // request. Better to surface a 503 to the client than to let
        // a stale token through during a DB hiccup.
        return res.status(503).json({
            success: false,
            message: 'Auth check unavailable. Try again.',
        });
    }

    req.user = decoded;
    next();
};

// --- 2. ADMIN ONLY PROTECTION ---
const adminOnly = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: "Not authorized: User not authenticated."
        });
    }

    if (req.user.role === 'ADMIN') {
        next();
    } else {
        res.status(403).json({
            success: false,
            message: "Access denied: Admin clearance required for this operation."
        });
    }
};

module.exports = { protect, adminOnly };
