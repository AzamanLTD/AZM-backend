// controllers/sessionController.js
// =============================================================================
// AZAMAN — Session Management (Enterprise Readiness)
//
// Lists active sessions/devices and provides "sign out everywhere" (revoke
// all refresh tokens + bump tokenVersion so access JWTs die instantly).
//
// Routes:
//   GET  /api/security/sessions          — list active sessions
//   POST /api/security/sessions/revoke-all — sign out everywhere
//   POST /api/security/sessions/:id/revoke — revoke a single session
// =============================================================================

const logger = require('../src/config/logger');
const { revokeAllForUser } = require('../services/authTokenService');

/**
 * GET /api/security/sessions
 * List all active (unrevoked, unexpired) refresh tokens for the current user.
 * Each session includes the device (userAgent) and IP address from when it
 * was issued, plus the creation and expiry dates.
 */
exports.listSessions = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const sessions = await prisma.refreshToken.findMany({
            where: {
                userId,
                revokedAt: null,
                expiresAt: { gt: new Date() },
            },
            select: {
                id: true,
                userAgent: true,
                ipAddress: true,
                createdAt: true,
                expiresAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        // Format for the frontend — parse user agents into readable labels
        const formatted = sessions.map(s => ({
            id: s.id,
            device: _parseUserAgent(s.userAgent),
            userAgent: s.userAgent,
            ipAddress: s.ipAddress,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            isCurrent: s.id === req.headers['x-refresh-token'],
        }));

        return res.json({
            success: true,
            sessions: formatted,
            count: formatted.length,
        });
    } catch (e) {
        logger.error({ err: e }, '[sessions] list error');
        return res.status(500).json({
            success: false,
            message: 'Could not retrieve sessions.',
        });
    }
};

/**
 * POST /api/security/sessions/revoke-all
 * Sign out everywhere — revokes ALL active refresh tokens and bumps
 * tokenVersion so every in-flight access JWT is invalidated at the next
 * protect() check. The client should clear all local state and redirect
 * to login.
 */
exports.revokeAllSessions = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    try {
        const result = await revokeAllForUser(prisma, userId);
        logger.info({ userId, revokedCount: result.revokedCount }, '[sessions] revoked all sessions');
        return res.json({
            success: true,
            message: 'All sessions have been revoked. Please log in again.',
            revokedCount: result.revokedCount,
        });
    } catch (e) {
        logger.error({ err: e }, '[sessions] revoke-all error');
        return res.status(500).json({
            success: false,
            message: 'Could not revoke sessions.',
        });
    }
};

/**
 * POST /api/security/sessions/:id/revoke
 * Revoke a single session by its refresh token ID. Only allows revoking
 * sessions that belong to the current user.
 */
exports.revokeSession = async (req, res) => {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;
    const { id } = req.params;

    try {
        // Ensure the token belongs to this user before revoking
        const token = await prisma.refreshToken.findUnique({
            where: { id },
            select: { userId: true, revokedAt: true },
        });

        if (!token || token.userId !== userId) {
            return res.status(404).json({
                success: false,
                message: 'Session not found.',
            });
        }

        if (token.revokedAt) {
            return res.json({
                success: true,
                message: 'Session was already revoked.',
            });
        }

        await prisma.refreshToken.update({
            where: { id },
            data: { revokedAt: new Date() },
        });

        logger.info({ userId, sessionId: id }, '[sessions] revoked single session');
        return res.json({
            success: true,
            message: 'Session revoked.',
        });
    } catch (e) {
        logger.error({ err: e }, '[sessions] revoke error');
        return res.status(500).json({
            success: false,
            message: 'Could not revoke session.',
        });
    }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a User-Agent string into a human-readable device label.
 * Best-effort — User-Agent strings are notoriously inconsistent.
 */
function _parseUserAgent(ua) {
    if (!ua) return 'Unknown device';
    // Extract browser
    let browser = 'Unknown';
    if (/edg/i.test(ua)) browser = 'Edge';
    else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
    else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
    else if (/safari/i.test(ua)) browser = 'Safari';

    // Extract OS
    let os = 'Unknown';
    if (/android/i.test(ua)) os = 'Android';
    else if (/iphone|ipad|ios/i.test(ua)) os = 'iOS';
    else if (/windows/i.test(ua)) os = 'Windows';
    else if (/mac/i.test(ua)) os = 'macOS';
    else if (/linux/i.test(ua)) os = 'Linux';

    // Check for Flutter (mobile app)
    if (/dart|flutter/i.test(ua)) {
        return `${os === 'Android' ? 'Android' : 'iOS'} App`;
    }

    return `${browser} on ${os}`;
}

