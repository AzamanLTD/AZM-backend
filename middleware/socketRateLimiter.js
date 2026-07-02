// middleware/socketRateLimiter.js
// =============================================================================
// AZAMAN — PER-SOCKET-EVENT RATE LIMITING
// =============================================================================

const Redis = require('ioredis');

let _redisClient = null;
const _getRedis = () => {
    if (!process.env.REDIS_URL) return null;
    if (!_redisClient) {
        _redisClient = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: false,
            lazyConnect: true,
        });
        _redisClient.on('error', (err) => console.error('[socketRateLimiter] redis error:', err.message));
    }
    return _redisClient;
};

// In-memory fallback store: eventKey -> { count, windowStart }
const _memStore = new Map();

async function _incrAndCheck(key, windowMs, max) {
    const redis = _getRedis();
    if (redis) {
        const count = await redis.incr(key);
        if (count === 1) await redis.pexpire(key, windowMs);
        return count <= max;
    }
    // Memory fallback
    const now = Date.now();
    const entry = _memStore.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
        _memStore.set(key, { count: 1, windowStart: now });
        return true;
    }
    entry.count += 1;
    return entry.count <= max;
}

// Per-event limits, tuned per action's real-world burst needs.
const EVENT_LIMITS = {
    send_friend_message:  { windowMs: 10_000, max: 20 },
    send_group_message:   { windowMs: 10_000, max: 20 },
    send_trade_message:   { windowMs: 10_000, max: 20 },
    send_ticket_message:  { windowMs: 10_000, max: 20 },
    react_to_message:     { windowMs: 10_000, max: 40 },
    typing:               { windowMs: 5_000,  max: 30 },
    join_group:           { windowMs: 10_000, max: 30 },
    join_trade:           { windowMs: 10_000, max: 30 },
};
const DEFAULT_LIMIT = { windowMs: 10_000, max: 60 };

/**
 * Attach to a connected socket
 */
function attach(socket) {
    socket.use((packet, next) => {
        const [eventName] = packet;
        const limit = EVENT_LIMITS[eventName] || DEFAULT_LIMIT;
        
        // Safety check: Ensure socket.user exists
        if (!socket.user || !socket.user.id) {
            return next();
        }
        
        const key = `sock_rl:${socket.user.id}:${eventName}`;

        _incrAndCheck(key, limit.windowMs, limit.max)
            .then((allowed) => {
                if (!allowed) {
                    socket.emit('rate_limited', {
                        event: eventName,
                        message: 'Too many requests -- please slow down.',
                    });
                    return; // swallow the packet, do not call next()
                }
                next();
            })
            .catch((err) => {
                // Fail OPEN on limiter infra errors
                console.error('[socketRateLimiter] check failed, failing open:', err.message);
                next();
            });
    });
}

module.exports = { attach, EVENT_LIMITS };
