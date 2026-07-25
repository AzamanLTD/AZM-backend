// src/sockets/socketAuth.js
// =============================================================================
// Socket.IO JWT authentication middleware (CRITICAL-4).
// Verifies the JWT from the handshake and attaches the decoded user to the
// socket. Rejects connections without a valid token.
// =============================================================================

const jwt = require('jsonwebtoken');

function createSocketAuthMiddleware(JWT_SECRET) {
    return (socket, next) => {
        const token = socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.replace('Bearer ', '');

        if (!token) {
            return next(new Error('Authentication required: No token provided.'));
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (!decoded.id) {
                return next(new Error('Authentication failed: Invalid token structure.'));
            }
            socket.user = decoded;
            next();
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return next(new Error('Authentication failed: Token expired.'));
            }
            return next(new Error('Authentication failed: Invalid token.'));
        }
    };
}

module.exports = { createSocketAuthMiddleware };
