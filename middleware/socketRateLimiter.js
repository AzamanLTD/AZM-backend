// middleware/socketRateLimiter.js
// =============================================================================
// AZAMAN — PER-SOCKET-EVENT RATE LIMITING
// =============================================================================

const { getRedis } = require('../src/lib/redisConnection');
const logger = require('../src/config/logger');

// Shared default connection — a socket storm must not open its own client.
const _getRedis = () => getRedis('default');

// In-memory fallback store: eventKey -> { count, windowStart }
const _memStore = new Map();
// Entries are only useful for one window. Without eviction this map grows with
// (user × event) forever in a long-lived process, so expired entries are swept
// opportunistically — cheap, bounded, and never on the packet's critical path.
let _memSweptAt = 0;
const MEM_SWEEP_INTERVAL_MS = 60_000;
function _sweepMemStore(now) {
    if (now - _memSweptAt < MEM_SWEEP_INTERVAL_MS) return;
    _memSweptAt = now;
    for (const [key, entry] of _memStore) {
        const ttl = DEFAULT_LIMIT.windowMs;
        if (now - entry.windowStart > Math.max(ttl, 60_000)) _memStore.delete(key);
    }
}

// INCR then PEXPIRE as two round-trips can crash between them, leaving a key
// with NO expiry: that socket would be rate-limited forever after the first
// packet. One script makes "create the counter" and "arm its window" a single
// atomic step, so a partial key cannot exist.
const _INCR_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

async function _incrAndCheck(key, windowMs, max) {
    const redis = _getRedis();
    if (redis) {
        const count = Number(await redis.eval(_INCR_WITH_TTL, 1, key, String(windowMs)));
        return count <= max;
    }
    // Memory fallback
    const now = Date.now();
    _sweepMemStore(now);
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
                // Fail OPEN on limiter infra errors — a limiter outage must never
                // hold a user's packets hostage.
                //
                // DEFECT C (2026-11-17): this handler used to call `logger.error`
                // while `logger` was NEVER imported, so the catch itself threw a
                // ReferenceError and `next()` was never called. Socket.IO then
                // stalled that packet forever, turning a designed fail-open into
                // a silent hang. The log call is now defensive as well: logging
                // must never be the reason a socket stops working.
                try {
                    logger.error({ err: err }, '[socketRateLimiter] check failed, failing open');
                } catch (_) { /* logging must never break the decision */ }
                next();
            });
    });
}

module.exports = { attach, EVENT_LIMITS };
