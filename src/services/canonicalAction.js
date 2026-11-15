// src/services/canonicalAction.js
// =============================================================================
// §WP-H G — the canonical description of a high-impact economic action.
//
// A step-up grant is only as strong as the action it is bound to. The binding
// must be computed SERVER-SIDE from the request that will actually execute, in a
// stable field order, so that one grant cannot authorise a different amount,
// currency, recipient, operation or resource.
//
// Money is carried as exact decimal STRINGS. No Number(), no parseFloat(): a
// value that survived a float round-trip is not the value the ledger will post.
// =============================================================================
'use strict';

const crypto = require('crypto');

const DECIMAL = /^-?\d+(\.\d+)?$/;

// Fields that must never influence (or leak into) a digest: they are either
// credentials or volatile transport noise.
const REDACTED_KEYS = new Set([
    'password', 'currentPassword', 'newPassword', 'totpToken', 'totp', 'otp',
    'stepUpToken', 'actionGrant', 'token', 'secret', 'authorization', 'cookie',
    'refreshToken', 'accessToken', 'signature',
]);

function assertExactDecimal(value, field) {
    if (value === null || value === undefined || value === '') {
        throw new Error(`${field} is required`);
    }
    // Refuse non-strings outright: String(100.5) === '100.5' would pass the
    // shape test while the float has already lost exactness.
    if (typeof value !== 'string') throw new Error(`${field} must be an exact decimal string`);
    const text = value.trim();
    if (!DECIMAL.test(text)) throw new Error(`${field} must be an exact decimal string`);
    return text;
}

function normaliseScalar(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        // A number that reached here has already lost precision; refuse rather
        // than silently authorise a rounded amount.
        if (!Number.isFinite(value)) throw new Error('non-finite numeric parameter');
        throw new Error('numeric parameters must be supplied as exact decimal strings');
    }
    throw new Error(`unsupported parameter type: ${typeof value}`);
}

/** Stable, redacted, order-independent view of arbitrary request parameters. */
function canonicalParams(params = {}) {
    const out = {};
    for (const key of Object.keys(params).sort()) {
        if (REDACTED_KEYS.has(key)) continue;
        const value = params[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) { out[key] = value.map(normaliseScalar); continue; }
        if (value && typeof value === 'object') { out[key] = canonicalParams(value); continue; }
        out[key] = normaliseScalar(value);
    }
    return out;
}

/**
 * The canonical action. `routeScope` is the endpoint identity, `actionType` the
 * economic operation. Anything not listed here cannot be bound, and is refused.
 */
function canonicalAction(input) {
    const {
        userId, actionType, routeScope, method, path,
        currency = null, amount = null, destination = null, resource = null,
        idempotencyKey = null, params = {},
    } = input || {};

    for (const [field, value] of Object.entries({ userId, actionType, routeScope, method, path })) {
        if (!value) throw new Error(`${field} is required to bind a step-up grant`);
    }

    return {
        userId: String(userId),
        actionType: String(actionType),
        routeScope: String(routeScope),
        method: String(method).toUpperCase(),
        path: String(path),
        currency: currency === null ? null : String(currency).toUpperCase(),
        amount: amount === null ? null : assertExactDecimal(amount, 'amount'),
        destination: destination === null ? null : String(destination).trim(),
        resource: resource === null ? null : String(resource),
        idempotencyKey: idempotencyKey === null ? null : String(idempotencyKey),
        params: canonicalParams(params),
    };
}

function actionDigest(action) {
    return crypto.createHash('sha256').update(JSON.stringify(action), 'utf8').digest('hex');
}

module.exports = { canonicalAction, actionDigest, canonicalParams, assertExactDecimal, REDACTED_KEYS };
