// src/sockets/socketAuth.js
// =============================================================================
// Socket.IO JWT authentication middleware (CRITICAL-4, Phase K).
// Verifies the JWT from the handshake and attaches the decoded user to the
// socket. Rejects connections without a valid token.
//
// Phase K addition: live tokenVersion check — if the user's live
// tokenVersion in the DB exceeds the claim in the JWT, the socket
// connection is rejected (the client must refresh its token first).
// Also rejects banned and deleted users at handshake time so a
// revoked account cannot maintain a real-time connection.
// =============================================================================

const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

function createSocketAuthMiddleware(JWT_SECRET) {
    return async (socket, next) => {
        const token = socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.replace('Bearer ', '');

        if (!token) {
            return next(new Error('Authentication required: No token provided.'));
        }

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return next(new Error('Authentication failed: Token expired.'));
            }
            return next(new Error('Authentication failed: Invalid token.'));
        }

        if (!decoded || !decoded.id) {
            return next(new Error('Authentication failed: Invalid token structure.'));
        }

        // ── Phase K: live-user tokenVersion + ban check ──────────────
        // Prevents stale-token socket connections after privilege changes.
        const prisma = socket.server?.app?.get?.('prisma');
        if (prisma) {
            try {
                const liveUser = await prisma.user.findUnique({
                    where: { id: decoded.id },
                    select: { tokenVersion: true, banStatus: true, isDeleted: true },
                });

                if (!liveUser || liveUser.isDeleted) {
                    return next(new Error('Authentication failed: User no longer exists.'));
                }

                if (liveUser.banStatus && liveUser.banStatus !== 'ACTIVE') {
                    return next(new Error('Authentication failed: Account is banned.'));
                }

                const claimVersion = typeof decoded.tokenVersion === 'number'
                    ? decoded.tokenVersion
                    : 0;

                if (liveUser.tokenVersion > claimVersion) {
                    return next(new Error('Authentication failed: Token superseded. Please refresh.'));
                }
            } catch (dbErr) {
                logger.error({ err: dbErr }, '[socketAuth] live-user lookup failed');
                // Fail closed: refuse connection during DB issues.
                return next(new Error('Authentication unavailable. Try again.'));
            }
        }

        socket.user = decoded;
        next();
    };
}

module.exports = { createSocketAuthMiddleware };
