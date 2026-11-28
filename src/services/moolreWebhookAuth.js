// src/services/moolreWebhookAuth.js
// =============================================================================
// ONE verifier for every callback/webhook Moolre sends us.
//
// Moolre's documented contract (docs.moolre.com, guides/webhooks-and-callbacks
// and api/payments/webhook, read 2026-11-27):
//   • X-Moolre-Signature: t=<unix seconds>,v1=<hex>
//     v1 = HMAC-SHA256("<t>.<raw body>") keyed with the wallet secret.
//     Compare in constant time over the RAW body bytes; refuse when t is more
//     than 5 minutes from our clock (replay window).
//   • data.secret in the body is the LEGACY method, deprecated and removed after
//     2027-03-31. Accepted until then, compared in constant time.
//   • Source-IP allow-listing is an extra safeguard only, never a substitute.
//
// Not documented, therefore not trusted in production:
//   • the static header x-moolre-webhook-secret;
//   • a bare-hex HMAC of the raw body without the "<t>." prefix.
// Both remain accepted OUTSIDE production only, so existing harnesses keep
// working while production follows the provider's contract.
//
// A body that ASSERTS a secret (data.secret or a top-level secret) must assert
// the right one, whatever else authenticates the request (WP-I matrix case 4).
// =============================================================================
'use strict';

const crypto = require('crypto');

const SIGNATURE_TOLERANCE_SECONDS = 300;
const LEGACY_BODY_SECRET_SUNSET_MS = Date.parse('2027-04-01T00:00:00Z');

function constantTimeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Parse "t=1700000000,v1=abcd…" (order and spacing tolerant). */
function parseSignatureHeader(value) {
    if (typeof value !== 'string' || !value.includes('=')) return null;
    const parts = {};
    for (const piece of value.split(',')) {
        const i = piece.indexOf('=');
        if (i <= 0) continue;
        parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
    }
    if (!/^\d+$/.test(parts.t || '') || !/^[0-9a-fA-F]+$/.test(parts.v1 || '')) return null;
    return { t: Number(parts.t), v1: parts.v1.toLowerCase() };
}

function sign(secret, t, rawBody) {
    return crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
}

/**
 * @returns {{ ok: true, method: string } | { ok: false, status: number, reason: string }}
 */
function verifyMoolreCallback({
    headers = {}, rawBody, body, secret,
    nowMs = Date.now(), nodeEnv = process.env.NODE_ENV,
} = {}) {
    if (!secret) return { ok: false, status: 503, reason: 'WEBHOOK_NOT_CONFIGURED' };
    const raw = typeof rawBody === 'string' ? rawBody : (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : JSON.stringify(body || {}));
    const production = nodeEnv === 'production';

    // A body that asserts a secret must assert the right one.
    const assertedSecrets = [body && body.data && body.data.secret, body && body.secret]
        .filter((v) => v !== undefined && v !== null);
    for (const asserted of assertedSecrets) {
        if (!constantTimeEqual(String(asserted), secret)) return { ok: false, status: 401, reason: 'BODY_SECRET_MISMATCH' };
    }

    const header = headers['x-moolre-signature'];
    const parsed = parseSignatureHeader(header);
    if (parsed) {
        const skew = Math.abs(nowMs / 1000 - parsed.t);
        if (skew > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, status: 401, reason: 'SIGNATURE_EXPIRED' };
        return constantTimeEqual(parsed.v1, sign(secret, parsed.t, raw))
            ? { ok: true, method: 'SIGNATURE' }
            : { ok: false, status: 401, reason: 'SIGNATURE_INVALID' };
    }

    // Legacy documented method, until Moolre removes it.
    const legacy = body && body.data && body.data.secret;
    if (legacy !== undefined && legacy !== null && nowMs < LEGACY_BODY_SECRET_SUNSET_MS) {
        // Already proven equal above.
        return { ok: true, method: 'LEGACY_BODY_SECRET' };
    }

    if (!production) {
        if (typeof header === 'string' && /^[0-9a-fA-F]{64}$/.test(header)
            && constantTimeEqual(header.toLowerCase(), crypto.createHmac('sha256', secret).update(raw).digest('hex'))) {
            return { ok: true, method: 'NONPROD_BARE_HMAC' };
        }
        for (const name of ['x-moolre-webhook-secret']) {
            if (constantTimeEqual(headers[name], secret)) return { ok: true, method: 'NONPROD_STATIC_HEADER' };
        }
    }
    return { ok: false, status: 401, reason: header ? 'SIGNATURE_INVALID' : 'MISSING_AUTHENTICATION' };
}

module.exports = {
    verifyMoolreCallback,
    parseSignatureHeader,
    sign,
    SIGNATURE_TOLERANCE_SECONDS,
    LEGACY_BODY_SECRET_SUNSET_MS,
};
