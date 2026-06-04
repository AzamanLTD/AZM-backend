// middleware/rateLimitMiddleware.js
// =============================================================================
// AZAMAN V3 — RATE LIMITING (Production Security)
//
// Tiered rate limits to prevent:
//   - Brute-force login attacks
//   - Trade spam / financial abuse
//   - DDoS / resource exhaustion
//   - Webhook flooding
//
// Uses in-memory store (suitable for single-instance). For multi-instance
// deployment, swap to a Redis-backed store (rate-limit-redis).
// =============================================================================

// Simple in-memory rate limiter (no external dependencies needed)
// Uses a sliding window counter per key

class RateLimiter {
    constructor({ windowMs, max, message, keyGenerator }) {
        this.windowMs = windowMs;
        this.max = max;
        this.message = message || 'Too many requests, please try again later.';
        this.keyGenerator = keyGenerator || ((req) => req.ip || req.connection.remoteAddress || 'unknown');
        this.hits = new Map(); // key → { count, resetTime }

        // Cleanup expired entries every minute
        this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
    }

    middleware() {
        return (req, res, next) => {
            const key = this.keyGenerator(req);
            const now = Date.now();
            const record = this.hits.get(key);

            if (!record || now > record.resetTime) {
                // New window
                this.hits.set(key, { count: 1, resetTime: now + this.windowMs });
                res.setHeader('X-RateLimit-Limit', this.max);
                res.setHeader('X-RateLimit-Remaining', this.max - 1);
                return next();
            }

            if (record.count >= this.max) {
                const retryAfter = Math.ceil((record.resetTime - now) / 1000);
                res.setHeader('Retry-After', retryAfter);
                res.setHeader('X-RateLimit-Limit', this.max);
                res.setHeader('X-RateLimit-Remaining', 0);
                return res.status(429).json({
                    success: false,
                    message: this.message,
                    retryAfter
                });
            }

            record.count++;
            res.setHeader('X-RateLimit-Limit', this.max);
            res.setHeader('X-RateLimit-Remaining', this.max - record.count);
            next();
        };
    }

    _cleanup() {
        const now = Date.now();
        for (const [key, record] of this.hits) {
            if (now > record.resetTime) {
                this.hits.delete(key);
            }
        }
    }

    destroy() {
        clearInterval(this._cleanupInterval);
        this.hits.clear();
    }
}

// ── Pre-configured limiters for different route tiers ────────────────────────

// AUTH: 5 requests per minute per IP (brute-force protection)
const authLimiter = new RateLimiter({
    windowMs: 60_000,
    max: 5,
    message: 'Too many login attempts. Please wait 60 seconds before trying again.'
}).middleware();

// FINANCIAL: 10 requests per minute per user (trade/withdraw/deposit)
//
// keyGenerator must run BEFORE the `protect` middleware sets req.user, so we
// decode the JWT here directly (no signature verification needed — we just
// need a stable per-user bucket key; if the token is forged, `protect` will
// reject it downstream). Falling back to IP when no Authorization header is
// present preserves the original behaviour for unauthenticated abuse.
const financialLimiter = new RateLimiter({
    windowMs: 60_000,
    max: 10,
    message: 'Too many financial requests. Please slow down.',
    keyGenerator: (req) => {
        if (req.user?.id) return `user_${req.user.id}`;
        const auth = req.headers.authorization || '';
        if (auth.startsWith('Bearer ')) {
            try {
                const decoded = require('jsonwebtoken').decode(auth.slice(7));
                if (decoded?.id) return `user_${decoded.id}`;
            } catch (_) { /* fall through to IP */ }
        }
        return req.ip || 'unknown';
    }
}).middleware();

// GENERAL API: 60 requests per minute per IP
const generalLimiter = new RateLimiter({
    windowMs: 60_000,
    max: 60,
    message: 'Rate limit exceeded. Please try again shortly.'
}).middleware();

// WEBHOOK: 30 requests per minute per IP (payment provider callbacks)
const webhookLimiter = new RateLimiter({
    windowMs: 60_000,
    max: 30,
    message: 'Webhook rate limit exceeded.'
}).middleware();

// STRICT: 3 requests per minute (account deletion, security changes)
const strictLimiter = new RateLimiter({
    windowMs: 60_000,
    max: 3,
    message: 'This action is rate-limited for security. Please wait.'
}).middleware();

module.exports = {
    RateLimiter,
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
    strictLimiter
};
