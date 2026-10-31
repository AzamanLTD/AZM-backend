// services/firebase/idTokenVerifier.js
// =============================================================================
// Firebase ID token verification WITHOUT firebase-admin.
//
// PROOF OF CONCEPT - isolated branch only. Not wired into production routes.
//
// firebase-admin is wanted by the dependency audit only because of its
// transitive chain firestore -> google-gax -> rimraf -> glob -> minimatch. The
// backend uses two Admin capabilities, and only two:
//
//   1. getAuth().verifyIdToken(idToken)   <- this file
//   2. getMessaging().send(message)       <- ./fcmClient.js
//
// This module replaces (1). Verification is explicit rather than delegated:
// every check is a named step, so a missing check is a visible omission rather
// than a silent library default.
//
// Threat model: an attacker can mint any JWT they like. Only a signature that
// validates against the current Google key for the expected project may be
// accepted. Everything else is refused.
// =============================================================================

const crypto = require('crypto');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;
const ACCEPTED_ALG = 'RS256';

class IdTokenError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'IdTokenError';
        this.code = code;
    }
}

function b64urlToBuffer(segment) {
    if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) {
        throw new IdTokenError('ID_TOKEN_MALFORMED', 'Token segment is not base64url.');
    }
    return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment(segment, label) {
    let parsed;
    try {
        parsed = JSON.parse(b64urlToBuffer(segment).toString('utf8'));
    } catch (err) {
        if (err instanceof IdTokenError) throw err;
        throw new IdTokenError('ID_TOKEN_MALFORMED', label + ' is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new IdTokenError('ID_TOKEN_MALFORMED', label + ' is not a JSON object.');
    }
    return parsed;
}

function splitToken(idToken) {
    if (typeof idToken !== 'string') {
        throw new IdTokenError('ID_TOKEN_MALFORMED', 'ID token is not a string.');
    }
    const parts = idToken.split('.');
    if (parts.length !== 3) {
        throw new IdTokenError('ID_TOKEN_MALFORMED', 'ID token must have three segments.');
    }
    return { headerB64: parts[0], payloadB64: parts[1], signatureB64: parts[2] };
}

/**
 * Caching JWKS resolver. An unknown `kid` triggers exactly one refetch, which
 * is how Google's key rotation is picked up without a redeploy. A second miss
 * fails closed instead of looping.
 */
function createKeyResolver({ jwksUrl = GOOGLE_JWKS_URL, fetcher, ttlMs = DEFAULT_JWKS_TTL_MS, now = () => Date.now() } = {}) {
    if (typeof fetcher !== 'function') {
        throw new Error('createKeyResolver requires a fetcher(url) -> Promise<{keys}>');
    }
    let keys = [];
    let fetchedAt = 0;

    async function load() {
        const body = await fetcher(jwksUrl);
        if (!body || !Array.isArray(body.keys)) {
            throw new IdTokenError('JWKS_UNAVAILABLE', 'Key set response is not a JWKS document.');
        }
        // Only RSA signing keys are usable here; everything else is dropped
        // rather than allowed to reach crypto.verify.
        keys = body.keys.filter((k) => k && k.kty === 'RSA' && k.n && k.e && (!k.alg || k.alg === ACCEPTED_ALG));
        fetchedAt = now();
    }

    return async function resolve(kid) {
        if (keys.length === 0 || now() - fetchedAt > ttlMs) await load();
        let match = keys.find((k) => k.kid === kid);
        if (!match) {
            await load();
            match = keys.find((k) => k.kid === kid);
        }
        if (!match) throw new IdTokenError('ID_TOKEN_UNKNOWN_KEY', 'No signing key matches this token.');
        return match;
    };
}

function verifySignature({ headerB64, payloadB64, signatureB64 }, jwk) {
    let key;
    try {
        key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (err) {
        throw new IdTokenError('ID_TOKEN_BAD_KEY', 'Signing key is not a usable RSA public key.');
    }
    const ok = crypto.verify(
        'RSA-SHA256',
        Buffer.from(headerB64 + '.' + payloadB64, 'utf8'),
        key,
        b64urlToBuffer(signatureB64),
    );
    if (!ok) throw new IdTokenError('ID_TOKEN_BAD_SIGNATURE', 'Signature does not verify.');
}

async function verifyIdToken(idToken, { projectId, resolveKey, now = () => Date.now() } = {}) {
    if (!projectId || typeof projectId !== 'string') {
        throw new IdTokenError('ID_TOKEN_NO_PROJECT', 'A project id is required to verify audience and issuer.');
    }
    if (typeof resolveKey !== 'function') {
        throw new IdTokenError('ID_TOKEN_NO_KEYS', 'A key resolver is required.');
    }

    const parts = splitToken(idToken);
    const header = decodeSegment(parts.headerB64, 'Header');
    const claims = decodeSegment(parts.payloadB64, 'Payload');

    // 1. Algorithm pinning BEFORE any key work, so 'none' and HS* can never
    //    reach a comparison (the public key must not be usable as an HMAC key).
    if (header.alg !== ACCEPTED_ALG) {
        throw new IdTokenError('ID_TOKEN_BAD_ALG', 'Unsupported algorithm: ' + String(header.alg) + '.');
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
        throw new IdTokenError('ID_TOKEN_NO_KID', 'Token header has no key id.');
    }

    // 2. Signature against the resolved Google key.
    const jwk = await resolveKey(header.kid);
    verifySignature(parts, jwk);

    // 3. Claims. A valid signature is not identity: a correctly signed token
    //    minted for a DIFFERENT Firebase project must still be refused.
    const skew = DEFAULT_CLOCK_SKEW_SECONDS;
    const nowSec = Math.floor(now() / 1000);

    if (claims.aud !== projectId) {
        throw new IdTokenError('ID_TOKEN_BAD_AUDIENCE', 'Token audience is a different project.');
    }
    if (claims.iss !== 'https://securetoken.google.com/' + projectId) {
        throw new IdTokenError('ID_TOKEN_BAD_ISSUER', 'Token issuer is a different project.');
    }
    if (typeof claims.exp !== 'number' || claims.exp + skew <= nowSec) {
        throw new IdTokenError('ID_TOKEN_EXPIRED', 'Token is expired.');
    }
    if (typeof claims.iat !== 'number' || claims.iat - skew > nowSec) {
        throw new IdTokenError('ID_TOKEN_BAD_ISSUED_AT', 'Token was issued in the future.');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 128) {
        throw new IdTokenError('ID_TOKEN_BAD_SUBJECT', 'Token subject is missing or too long.');
    }
    if (claims.auth_time !== undefined && typeof claims.auth_time !== 'number') {
        throw new IdTokenError('ID_TOKEN_BAD_AUTH_TIME', 'auth_time is not a number.');
    }
    if (claims.user_id !== undefined && claims.user_id !== claims.sub) {
        throw new IdTokenError('ID_TOKEN_SUBJECT_MISMATCH', 'sub and user_id disagree.');
    }

    return claims;
}

module.exports = {
    verifyIdToken,
    createKeyResolver,
    IdTokenError,
    GOOGLE_JWKS_URL,
    ACCEPTED_ALG,
};
