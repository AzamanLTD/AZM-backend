// controllers/refreshController.js
// =============================================================================
// AZAMAN — Phase K refresh & logout endpoints
//
// POST /api/auth/refresh
//   Body: { refreshToken }
//   Validates the refresh token (exists, not revoked, not expired,
//   user active), rotates it (creates a new row + revokes the old),
//   and returns a fresh access JWT (15min) plus the new refresh token.
//   The client should immediately discard the old refresh token from
//   storage and replace it with the new one. This is one-time-use:
//   replaying the old token after it's been rotated will fail.
//
// POST /api/auth/logout
//   Body: { refreshToken }
//   Marks the inbound refresh token as revoked. The client should also
//   discard the access token from storage. The access token will keep
//   working until it expires naturally on its 15-minute window — a
//   short-lived risk that's the standard tradeoff for stateless JWTs.
//   For higher-stakes "force logout" (e.g., after detecting a compromise),
//   the admin endpoint bumps tokenVersion which invalidates ALL access
//   JWTs immediately at protect() time.
// =============================================================================

const logger = require('../src/config/logger');
const {
    rotateRefreshToken,
    revokeRefreshToken,
} = require('../services/authTokenService');
const { recordDailyLogin } = require('../services/loginStreakService');

exports.refresh = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { refreshToken } = req.body || {};

    if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'refreshToken is required.',
        });
    }

    try {
        const result = await rotateRefreshToken(prisma, refreshToken, {
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
        });

        if (!result) {
            return res.status(401).json({
                success: false,
                message: 'Refresh token is invalid, expired, or revoked. Please log in again.',
                code: 'REFRESH_INVALID',
            });
        }

        // BUGFIX (2026-07-06): /refresh is what silently fires on almost
        // every app re-open once a user has a valid session -- it never
        // recorded the daily login streak at all before this, so the streak
        // was effectively frozen at day 1 for anyone who doesn't explicitly
        // log out and back in. See services/loginStreakService.js header.
        // Best-effort: a streak-recording hiccup must never fail the token
        // refresh itself, which is on the hot path for every authenticated
        // request cycle. Awaited (unlike the AZM reward push inside, which
        // stays fire-and-forget) so the streak write is guaranteed to have
        // committed by the time this response returns -- it's a single fast
        // UPDATE on the common "same calendar day" path it usually no-ops
        // entirely, so this doesn't add meaningful latency to /refresh.
        try {
            await recordDailyLogin(prisma, result.user, req.app.get('azmRewardService'));
        } catch (err) {
            logger.error({ err: err }, '[refresh] login streak record error');
        }

        return res.status(200).json({
            success: true,
            // Phase K — clients should switch to consuming `accessToken`. The
            // legacy `token` field is kept for one release cycle while every
            // FE callsite migrates.
            token: result.accessToken,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            refreshExpiresAt: result.refreshExpiresAt.toISOString(),
            user: {
                id: result.user.id,
                username: result.user.username,
                role: result.user.role,
            },
        });
    } catch (e) {
        logger.error({ err: e }, '[refresh] error');
        return res.status(500).json({
            success: false,
            message: 'Internal server error during refresh.',
        });
    }
};

exports.logout = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { refreshToken } = req.body || {};

    // Logout is best-effort. Even if the refresh token is missing or invalid
    // we 200 — the client wants to clear local state regardless.
    try {
        if (refreshToken && typeof refreshToken === 'string') {
            await revokeRefreshToken(prisma, refreshToken);
        }
        return res.status(200).json({ success: true, message: 'Logged out.' });
    } catch (e) {
        logger.error({ err: e }, '[logout] error');
        // Still return 200 — client should clear local state regardless.
        return res.status(200).json({ success: true, message: 'Logged out.' });
    }
};
