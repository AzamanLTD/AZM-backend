// middleware/rateLimitMiddleware.js
// =============================================================================
// AZAMAN V3 — RATE LIMITING (Production Security, multi-instance safe)
//
// Tiered rate limits to prevent:
//   - Brute-force login attacks
//   - Trade spam / financial abuse
//   - DDoS / resource exhaustion
//   - Webhook flooding
//
// WS1 (2026-06-18): replaced the in-memory Map limiter with `express-rate-limit`
// backed by `rate-limit-redis`. The previous limiter kept its counters in a
// per-process Map, so the moment Render auto-scaled to 2+ instances each one had
// its own counter — N instances meant N× the real limit (effectively no limit).
//
// Reuses the same REDIS_URL already used by the Socket.IO adapter (server.js).
// When REDIS_URL is set, all instances share one counter store. When it is NOT
// set (local dev / single-box), it falls back to express-rate-limit's built-in
// memory store with a loud warning — same behaviour class as before, single
// instance only.
//
// Thresholds are intentionally kept at the project's existing (stricter) values,
// not loosened. The per-user keying on the financial tier is preserved too.
// =============================================================================

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const Redis = require('ioredis');

// ── Shared Redis-backed store factory ────────────────────────────────────────
// One ioredis client, lazily connected, shared by every limiter. If REDIS_URL
// is unset we return undefined so each limiter falls back to the memory store.
let _redisClient = null;
const _getStore = () => {
    if (!process.env.REDIS_URL) return undefined;
    if (!_redisClient) {
        // Upstash uses rediss:// (TLS). ioredis handles the protocol automatically
        // but needs tls:{} option set explicitly when the URL is rediss://.
        const isTLS = process.env.REDIS_URL.startsWith('rediss://');
        _redisClient = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            enableReadyCheck: false,
            lazyConnect: true,
            ...(isTLS ? { tls: {} } : {}),
        });
        _redisClient.on('error', (e) => console.error('[RateLimit] Redis error:', e.message));
        console.log('[RateLimit] Using Redis store — multi-instance safe' + (isTLS ? ' (TLS/Upstash)' : ''));
    }
    // A fresh RedisStore per limiter (each gets its own key prefix) but they all
    // share the single underlying connection.
    return (prefix) => new RedisStore({
        sendCommand: (...args) => _redisClient.call(...args),
        prefix,
    });
};

const _storeFactory = _getStore();
if (!_storeFactory) {
    console.warn('[RateLimit] REDIS_URL not set — using in-memory store. OK for dev, NOT for multi-instance production.');
}

// Build the standard options for a limiter, attaching a Redis store (with a
// unique prefix) only when one is available.
const _opts = ({ windowMs, max, message, keyGenerator, prefix }) => ({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
    ...(keyGenerator ? { keyGenerator } : {}),
    ...(_storeFactory ? { store: _storeFactory(prefix) } : {}),
});

// ── AUTH: 5 requests per minute per IP (brute-force protection) ───────────────
const authLimiter = rateLimit(_opts({
    windowMs: 60_000,
    max: 5,
    prefix: 'rl:auth:',
    message: 'Too many login attempts. Please wait 60 seconds before trying again.',
}));

// ── FINANCIAL: 10 requests per minute per USER (trade/withdraw/deposit) ───────
// keyGenerator runs BEFORE `protect` sets req.user, so we decode the JWT here
// directly (no signature verification needed — we only need a stable per-user
// bucket; a forged token is rejected downstream by `protect`). Falls back to the
// IPv6-safe IP key when there is no Authorization header.
const _financialKey = (req, res) => {
    if (req.user?.id) return `user_${req.user.id}`;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
        try {
            const decoded = require('jsonwebtoken').decode(auth.slice(7));
            if (decoded?.id) return `user_${decoded.id}`;
        } catch (_) { /* fall through to IP */ }
    }
    return ipKeyGenerator(req, res);
};

const financialLimiter = rateLimit(_opts({
    windowMs: 60_000,
    max: 10,
    prefix: 'rl:fin:',
    keyGenerator: _financialKey,
    message: 'Too many financial requests. Please slow down.',
}));

// ── GENERAL API: 60 requests per minute per IP ───────────────────────────────
const generalLimiter = rateLimit(_opts({
    windowMs: 60_000,
    max: 60,
    prefix: 'rl:gen:',
    message: 'Rate limit exceeded. Please try again shortly.',
}));

// ── WEBHOOK: 30 requests per minute per IP (payment provider callbacks) ───────
const webhookLimiter = rateLimit(_opts({
    windowMs: 60_000,
    max: 30,
    prefix: 'rl:hook:',
    message: 'Webhook rate limit exceeded.',
}));

// ── STRICT: 3 requests per minute (account deletion, security changes) ────────
const strictLimiter = rateLimit(_opts({
    windowMs: 60_000,
    max: 3,
    prefix: 'rl:strict:',
    message: 'This action is rate-limited for security. Please wait.',
}));

module.exports = {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
    strictLimiter,
};
