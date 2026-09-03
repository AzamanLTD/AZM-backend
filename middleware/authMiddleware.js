// middleware/authMiddleware.js
// =============================================================================
// AZAMAN V3 — AUTH MIDDLEWARE (Production-Hardened)
//
// Phase K — token-version validation
// =============================================================================

const logger = require('../src/config/logger');
const jwt = require('jsonwebtoken');
const { withRequestContext } = require('../utils/requestContext');

const JWT_SECRET = process.env.JWT_SECRET;
const SKIP_TOKEN_VERSION_CHECK = process.env.AUTH_SKIP_TOKEN_VERSION_CHECK === '1';

const protect = async (req, res, next) => {
    if (!(req.headers.authorization && req.headers.authorization.startsWith('Bearer'))) {
        return res.status(401).json({ success: false, message: "Not authorized: No Bearer token found in Authorization header." });
    }

    const token = req.headers.authorization.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: "Not authorized: Token not found in Bearer header." });
    }

    if (!JWT_SECRET) {
        logger.error('[authMiddleware] FATAL: JWT_SECRET is not configured.');
        return res.status(500).json({ success: false, message: "Server configuration error." });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: "Not authorized: Token has expired.", code: 'TOKEN_EXPIRED' });
        } else if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ success: false, message: "Not authorized: Invalid token." });
        }
        return res.status(401).json({ success: false, message: "Not authorized: Token verification failed." });
    }

    if (!decoded || !decoded.id) {
        return res.status(401).json({ success: false, message: "Not authorized: Invalid token structure." });
    }

    const prisma = req.app.get('prisma');
    try {
        const liveUser = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: { tokenVersion: true, banStatus: true, isDeleted: true },
        });

        if (!liveUser || liveUser.isDeleted) {
            return res.status(401).json({ success: false, message: "Not authorized: User no longer exists.", code: 'USER_GONE' });
        }

        if (liveUser.banStatus && liveUser.banStatus !== 'ACTIVE') {
            return res.status(403).json({ success: false, message: "Account is banned.", code: 'BANNED' });
        }

        if (!SKIP_TOKEN_VERSION_CHECK) {
            const claimVersion = typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;
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
        return res.status(503).json({ success: false, message: 'Auth check unavailable. Try again.' });
    }

    req.user = decoded;
    return withRequestContext(req, () => next());
};

const adminOnly = (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: "Not authorized: User not authenticated." });
    if (req.user.role === 'ADMIN') return next();
    return res.status(403).json({ success: false, message: "Access denied: Admin clearance required for this operation." });
};

module.exports = { protect, adminOnly };
