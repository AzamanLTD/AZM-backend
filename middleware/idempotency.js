// middleware/idempotency.js
// =============================================================================
// Idempotency-Key middleware for financial endpoints (Phase 2).
//
// Prevents double-execution of retried requests. If a client sends an
// `Idempotency-Key` header, the middleware:
//   1. Checks the DB for an existing record with that key
//   2. If found and not expired → returns the cached status + body
//   3. If not found → executes the request, then stores the response
//
// Keys expire after 24 hours. The middleware is non-blocking: if the DB
// is unavailable, the request proceeds normally (fail-open).
//
// Usage: Apply to specific routes:
//   router.post('/trades', idempotency(), tradeController.createTrade);
// =============================================================================

const logger = require('../src/config/logger');

const KEY_TTL_HOURS = 24;
const KEY_TTL_MS = KEY_TTL_HOURS * 60 * 60 * 1000;

/**
 * Express middleware that enforces idempotency via the Idempotency-Key header.
 * Apply to POST/PUT endpoints where double-execution is dangerous (financial ops).
 */
function idempotency() {
    return async (req, res, next) => {
        const key = req.headers['idempotency-key'];

        // No key → skip idempotency (optional header)
        if (!key) return next();

        const prisma = req.app.get('prisma');
        if (!prisma?.idempotencyKey) {
            // Model not available — fail open
            return next();
        }

        const endpoint = `${req.method} ${req.originalUrl}`;
        const userId = req.user?.id || null;

        try {
            // Check for an existing cached response
            const existing = await prisma.idempotencyKey.findUnique({
                where: { key },
            });

            if (existing && existing.expiresAt > new Date()) {
                // Return the cached response
                return res.status(existing.statusCode).json(existing.responseBody);
            }

            if (existing && existing.expiresAt <= new Date()) {
                // Expired — clean up the old record
                await prisma.idempotencyKey.delete({ where: { key } });
            }
        } catch (err) {
            // DB error — fail open, don't block the request
            logger.warn({ err: err.message, key }, '[idempotency] Lookup failed, proceeding without cache');
            return next();
        }

        // Intercept the response to cache it
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            // Only cache successful (2xx) and client-error (4xx) responses.
            // 5xx errors should not be cached — the client should retry.
            if (res.statusCode >= 200 && res.statusCode < 500) {
                prisma.idempotencyKey.create({
                    data: {
                        key,
                        userId,
                        endpoint,
                        statusCode: res.statusCode,
                        responseBody: body,
                        expiresAt: new Date(Date.now() + KEY_TTL_MS),
                    },
                }).catch(err => {
                    logger.warn({ err: err.message, key }, '[idempotency] Failed to cache response');
                });
            }
            return originalJson(body);
        };

        next();
    };
}

module.exports = { idempotency, KEY_TTL_HOURS };
