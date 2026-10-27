// middleware/optionalAuth.js
// =============================================================================
// OPTIONAL AUTH — resolves the viewer's identity when a valid Bearer token is
// present, but NEVER rejects the request. Used by public routes that can
// personalise their response when the caller is authenticated (e.g. the
// public business search attaching per-viewer unseen-story state).
//
// Mirrors protect's verification semantics exactly (JWT verify + live-user
// check with ban/deleted/tokenVersion rules) so an optionalAuth-resolved
// identity is as trustworthy as a protect-resolved one; the only difference
// is the failure mode: on ANY failure the request proceeds anonymously with
// req.user unset, and the route serves its public shape.

const jwt = require('jsonwebtoken');
const logger = require('../src/config/logger');
const JWT_SECRET = process.env.JWT_SECRET;
const SKIP_TOKEN_VERSION_CHECK = process.env.AUTH_SKIP_TOKEN_VERSION_CHECK === '1';

const optionalAuth = async (req, res, next) => {
    // No token at all — public request, proceed anonymously.
    if (!req.headers.authorization ||
        !req.headers.authorization.startsWith('Bearer') ||
        !req.headers.authorization.split(' ')[1]) {
        return next();
    }
    if (!JWT_SECRET) {
        // Misconfiguration is not this middleware's failure mode; the
        // request proceeds anonymously and protect-bearing routes remain
        // the ones that fail loudly.
        return next();
    }

    const token = req.headers.authorization.split(' ')[1];
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (_err) {
        return next(); // invalid/expired token: anonymous
    }
    if (!decoded || !decoded.id) return next();

    const prisma = req.app.get('prisma');
    if (!prisma) return next();
    try {
        const liveUser = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { tokenVersion: true, banStatus: true, isDeleted: true },
        });
        if (!liveUser || liveUser.isDeleted) return next();
        if (liveUser.banStatus && liveUser.banStatus !== 'ACTIVE') return next();
        if (!SKIP_TOKEN_VERSION_CHECK) {
            const claimVersion =
                typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;
            if (liveUser.tokenVersion > claimVersion) return next();
        }
        // Trustworthy identity: req.user carries exactly the fields protect
        // guarantees after its own checks.
        req.user = { id: decoded.id };
        return next();
    } catch (dbErr) {
        logger.warn({ err: dbErr }, '[optionalAuth] live-user lookup failed — proceeding anonymously');
        return next();
    }
};

module.exports = { optionalAuth };
