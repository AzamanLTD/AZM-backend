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
// HOTFIX (2026-07-25): Added fail-open wrappers around every limiter. When
// the Redis store errors (e.g., Upstash monthly quota exhausted, network
// partition), the limiter logs a warning and lets the request through instead
// of crashing with a 500. This is the standard "fail open" posture for rate
// limiting — it's better to temporarily lose rate-limit protection than to
// take the entire API offline. Rate limiting resumes automatically once Redis
// connectivity is restored.
//
// Thresholds are intentionally kept at the project's existing (stricter) values,
// not loosened. The per-user keying on the financial tier is preserved too.
// =============================================================================

const logger = require('../src/config/logger');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const Redis = require('ioredis');

// ── Shared Redis-backed store factory ────────────────────────────────────────
// One ioredis client, lazily connected, shared by every limiter. If REDIS_URL
// is unset we return undefined so each limiter falls back to the memory store.
let _redisClient = null;
let _redisErroring = false;
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
        _redisClient.on('error', (e) => {
            _redisErroring = true;
            logger.error({ err: e }, '[RateLimit] Redis error');
        });
        _redisClient.on('ready', () => {
            _redisErroring = false;
        });
        logger.info('[RateLimit] Using Redis store — multi-instance safe' + (isTLS ? ' (TLS/Upstash)' : ''));
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
    logger.warn('[RateLimit] REDIS_URL not set — using in-memory store. OK for dev, NOT for multi-instance production.');
}

// ── Fail-open wrapper (non-financial tiers) ──────────────────────────────────
// Wraps an express-rate-limit middleware so that if the underlying store
// throws (Redis down, Upstash quota exhausted, etc.), we log and let the
// request through instead of returning a 500. Rate limiting is a protection
// layer, not a critical path — failing open keeps the API alive.
const _failOpen = (limiter) => (req, res, next) => {
    // Fast path: if we already know Redis is erroring, skip the limiter entirely.
    if (_storeFactory && _redisErroring) {
        logger.warn('[RateLimit] Redis unavailable — failing open (rate limiting temporarily disabled)');
        return next();
    }
    limiter(req, res, (err) => {
        if (err) {
            _redisErroring = true;
            logger.warn({ err: err.message }, '[RateLimit] Store error — failing open');
            return next();
        }
        next();
    });
};

// ── Fail-SAFE wrapper (financial tier only) ─────────────────────────────────
// r15 follow-up: the financial tier previously shared the fail-open posture,
// which DISABLED financial rate limiting entirely for as long as Redis was
// unavailable (quota exhaustion lasted days in practice) — trade/withdraw/
// escrow endpoints became unlimited for attackers. Protection of financial
// endpoints must not be given up merely to keep availability: when the shared
// store is unavailable, the financial limiter degrades to an IN-PROCESS memory
// limiter with the same thresholds. That restores the per-instance bound
// (N instances → N× the cap — the documented no-Redis posture) instead of an
// unbounded window with NO protection at all.
const _memoryFinancialLimiter = () => {
    let cached = null;
    return (opts) => {
        if (!cached) {
            // Same thresholds; explicitly memory store, no Redis store.
            const { store, ...rest } = opts;
            cached = rateLimit(rest);
        }
        return cached;
    };
};
const _financialMemory = _memoryFinancialLimiter();
const _failSafeFinancial = (limiter, opts) => (req, res, next) => {
    const fallback = () => {
        logger.warn('[RateLimit] Financial tier degrading to in-process memory limiter (Redis unavailable)');
        _financialMemory(opts)(req, res, (err) => {
            // The memory store cannot fail; any error here is a bug — fail open
            // rather than 500 a financial request over our own protection bug.
            if (err) {
                logger.error({ err: err.message }, '[RateLimit] Financial memory limiter error — failing open');
                return next();
            }
            next();
        });
    };
    // Fast path: Redis already known erroring → memory limiter directly.
    // (No _storeFactory guard: _redisErroring only becomes true through a
    // real store error or the test hook, and when no Redis is configured at
    // all the limiter is already memory-based — the fallback is equivalent.)
    if (_redisErroring) return fallback();
    limiter(req, res, (err) => {
        if (err) {
            _redisErroring = true;
            logger.warn({ err: err.message }, '[RateLimit] Store error — financial tier degrading to memory limiter');
            return fallback();
        }
        next();
    });
};

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
const authLimiter = _failOpen(rateLimit(_opts({
    windowMs: 60_000,
    max: 5,
    prefix: 'rl:auth:',
    message: 'Too many login attempts. Please wait 60 seconds before trying again.',
})));

// ── FINANCIAL: 10 requests per minute per USER (trade/withdraw/deposit) ───────
// keyGenerator runs BEFORE `protect` sets req.user, so we inspect the JWT here
// directly. r15 follow-up (bucket-poisoning fix): the claim is now VERIFIED
// (signature + expiry, same JWT_SECRET `protect` enforces). The previous
// unverified `jwt.decode` let ANY client forge an Authorization header naming
// a victim's id and exhaust the victim's 10/min financial bucket — a targeted
// denial-of-service on someone's withdrawals/trades/savings/escrow. A forged
// or expired token now falls back to the attacker's own IP bucket, never the
// claimed victim's.
const jwt = require('jsonwebtoken');
const _financialKey = (req, res) => {
    if (req.user?.id) return `user_${req.user.id}`;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
        try {
            const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
            if (decoded?.id) return `user_${decoded.id}`;
        } catch (_) { /* unverified/invalid claim — fall through to the IP key */ }
    }
    // r15 follow-up (v8 API fix): express-rate-limit v8's ipKeyGenerator takes
    // the IP STRING (ipKeyGenerator(ip, ipv6Subnet)), not (req, res). The old
    // call passed the request object, which the function returned unchanged —
    // a fresh unique bucket key per request, so this fallback NEVER limited.
    return ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
};

const financialOpts = _opts({
    windowMs: 60_000,
    max: 10,
    prefix: 'rl:fin:',
    keyGenerator: _financialKey,
    message: 'Too many financial requests. Please slow down.',
});
const financialLimiter = _failSafeFinancial(rateLimit(financialOpts), financialOpts);

// ── GENERAL API: 60 requests per minute per IP ───────────────────────────────
const generalLimiter = _failOpen(rateLimit(_opts({
    windowMs: 60_000,
    max: 60,
    prefix: 'rl:gen:',
    message: 'Rate limit exceeded. Please try again shortly.',
})));

// ── E2EE BUNDLE CLAIM: 10 claims per 15 min per (claimant, target) pair ──────
// r40.3 (audit P1 — OPK exhaustion): every successful GET /api/e2ee/keys/:userId
// consumes one of the target's one-time prekeys. The relationship gate in
// keyService.fetchBundle blocks strangers entirely; this limiter bounds a
// MALICIOUS PEER — a user who does share a personal conversation with the
// victim cannot hammer the endpoint to drain their OPK pool. Keyed per pair
// so one abusive relationship never limits a claimant's sessions with OTHER
// peers.
// r40.4 (audit P2 — fail-open was unsafe): OPKs are a CONSUMPTIVE
// cryptographic resource — during a Redis outage, fail-open meant a
// conversation peer could drain a victim's OPK pool without any rate bound.
// This limiter is now FAIL-SAFE (same posture as the financial tier): a
// store error degrades to an in-process memory limiter with identical
// thresholds (per-instance bound) instead of unlimited claims.
// r40.4: dedicated fail-safe machinery for the bundle tier. It must NOT
// share the financial tier's cached memory limiter — the financial fallback
// singleton is built from FINANCIAL options (window/keying), and reusing it
// would key bundle claims with the financial key generator (or vice versa).
const _memoryBundleLimiter = (() => {
    let cached = null;
    return (opts) => {
        if (!cached) {
            const { store, ...rest } = opts;
            cached = rateLimit(rest);
        }
        return cached;
    };
})();
const _failSafeBundle = (limiter, opts) => (req, res, next) => {
    const fallback = () => {
        logger.warn('[RateLimit] E2EE bundle tier degrading to in-process memory limiter (Redis unavailable)');
        _memoryBundleLimiter(opts)(req, res, (err) => {
            if (err) {
                logger.error({ err: err.message }, '[RateLimit] E2EE bundle memory limiter error — failing open');
                return next();
            }
            next();
        });
    };
    if (_redisErroring) return fallback();
    limiter(req, res, (err) => {
        if (err) {
            _redisErroring = true;
            logger.warn({ err: err.message }, '[RateLimit] Store error — E2EE bundle tier degrading to memory limiter');
            return fallback();
        }
        next();
    });
};
const e2eeBundleOpts = _opts({
    windowMs: 15 * 60_000,
    max: 10,
    prefix: 'rl:e2ee-bundle:',
    keyGenerator: (req) => `pair_${req.user?.id ?? 'anon'}_${req.params?.userId ?? 'x'}`,
    message: 'Too many key bundle requests for this user. Please wait before retrying.',
});
const e2eeBundleLimiter = _failSafeBundle(rateLimit(e2eeBundleOpts), e2eeBundleOpts);

// ── WEBHOOK: 30 requests per minute per IP (payment provider callbacks) ───────
const webhookLimiter = _failOpen(rateLimit(_opts({
    windowMs: 60_000,
    max: 30,
    prefix: 'rl:hook:',
    message: 'Webhook rate limit exceeded.',
})));

// ── STRICT: 3 requests per minute (account deletion, security changes) ────────
const strictLimiter = _failOpen(rateLimit(_opts({
    windowMs: 60_000,
    max: 3,
    prefix: 'rl:strict:',
    message: 'This action is rate-limited for security. Please wait.',
})));

// Test hook: force the Redis-erroring state to prove the financial tier's
// degraded (memory-limiter) behavior without needing a real failing Redis.
const __setRedisErroringForTest = (v) => { _redisErroring = v === true; };

module.exports = {
    __setRedisErroringForTest,
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
    strictLimiter,
    e2eeBundleLimiter,
};