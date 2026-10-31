// services/firebase/idTokenVerifier.js
// =============================================================================
// Firebase ID token verification WITHOUT firebase-admin.
//
// PROOF OF CONCEPT - isolated branch only. Not wired into any production route.
//
// Replaces getAuth().verifyIdToken(idToken) so the firebase-admin dependency
// (wanted by the audit solely through firestore -> google-gax -> rimraf -> glob)
// can eventually leave the tree.
//
// PARITY WITH FIREBASE ADMIN, stated explicitly rather than assumed:
//   - Algorithm: RS256 only, pinned BEFORE any key lookup. firebase-admin pins
//     the same value and refuses everything else, including 'none' and HS*.
//   - Clock skew: 300 seconds, matching firebase-admin's CLOCK_SKEW_SECS. A
//     tighter window (this file previously used 60s) would reject logins that
//     production accepts today on a device with a slow clock, so parity wins.
//   - Claims: iss is https://securetoken.google.com/{project}, aud is the
//     project id, sub is 1..128 characters, exp must not be in the past.
//   - auth_time: firebase-admin only rejects auth_time that is a *number* in
//     the future and tolerates its absence. This file REQUIRES it (owner
//     requirement) and additionally requires it not to be in the future. That
//     is a deliberate, documented divergence: stricter, never looser.
//   - getAuth().verifyIdToken(idToken, true) (revocation check) is NOT
//     replicated. It needs a live identitytoolkit call. Callers relying on it
//     must keep doing so.
// =============================================================================

const crypto = require('crypto');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// firebase-admin: CLOCK_SKEW_SECS = 300.
const CLOCK_SKEW_SECONDS = 300;
// Fallback only. Google's Cache-Control max-age governs the real lifetime.
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;
const DEFAULT_JWKS_TIMEOUT_MS = 5000;
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

/** Parse Cache-Control max-age into milliseconds. null means "do not cache". */
function maxAgeFromCacheControl(cacheControl) {
    if (typeof cacheControl !== 'string' || cacheControl.length === 0) return undefined;
    const lower = cacheControl.toLowerCase();
    if (/(^|,)\s*no-store\s*(,|$)/.test(lower) || /(^|,)\s*no-cache\s*(,|$)/.test(lower)) return null;
    const match = /(^|,)\s*max-age\s*=\s*(\d+)/.exec(lower);
    return match ? Number(match[2]) * 1000 : undefined;
}

/**
 * Default JWKS fetcher: bounded by an AbortController so a hung TLS handshake
 * cannot hold a login open indefinitely. Returns the JWKS plus Google's
 * Cache-Control so the resolver can honour the real key lifetime.
 */
function createDefaultFetcher({ fetchImpl = global.fetch, timeoutMs = DEFAULT_JWKS_TIMEOUT_MS } = {}) {
    return async function fetchJwks(url) {
        if (typeof fetchImpl !== 'function') {
            throw new IdTokenError('JWKS_UNAVAILABLE', 'No HTTP client is available to fetch signing keys.');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (!res || res.ok === false) {
                throw new IdTokenError('JWKS_UNAVAILABLE', 'Key set request failed with status ' + (res && res.status) + '.');
            }
            const body = await res.json();
            const cacheControl = res.headers && typeof res.headers.get === 'function'
                ? res.headers.get('cache-control')
                : undefined;
            return { keys: body && body.keys, cacheControl };
        } catch (err) {
            if (err instanceof IdTokenError) throw err;
            if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
                throw new IdTokenError('JWKS_TIMEOUT', 'Key set request timed out after ' + timeoutMs + 'ms.');
            }
            throw new IdTokenError('JWKS_UNAVAILABLE', 'Key set request failed.');
        } finally {
            clearTimeout(timer);
        }
    };
}

/**
 * Caching JWKS resolver.
 *  - lifetime comes from Cache-Control max-age when present, else a 1h fallback
 *  - concurrent callers share ONE in-flight fetch
 *  - an unknown kid triggers exactly one refetch (Google rotation), then fails
 */
function createKeyResolver({ jwksUrl = GOOGLE_JWKS_URL, fetcher, ttlMs = DEFAULT_JWKS_TTL_MS, now = () => Date.now() } = {}) {
    if (typeof fetcher !== 'function') {
        throw new Error('createKeyResolver requires a fetcher(url) -> Promise<{keys}>');
    }
    let keys = [];
    let fetchedAt = 0;
    let expiresAt = 0;
    let inFlight = null;

    async function fetchOnce() {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const result = await fetcher(jwksUrl);
            // Accept a bare JWKS document or {keys, cacheControl}.
            const doc = result && Array.isArray(result.keys) ? result : null;
            if (!doc) throw new IdTokenError('JWKS_UNAVAILABLE', 'Key set response is not a JWKS document.');
            const cacheAge = maxAgeFromCacheControl(result.cacheControl);
            keys = doc.keys.filter((k) => k && k.kty === 'RSA' && k.n && k.e && (!k.alg || k.alg === ACCEPTED_ALG));
            fetchedAt = now();
            expiresAt = cacheAge === null ? fetchedAt : fetchedAt + (cacheAge === undefined ? ttlMs : cacheAge);
            return keys;
        })();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    }

    const isStale = () => keys.length === 0 || now() >= expiresAt;

    return async function resolve(kid) {
        if (isStale()) await fetchOnce();
        let match = keys.find((k) => k.kid === kid);
        if (!match) {
            await fetchOnce();
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

    if (header.alg !== ACCEPTED_ALG) {
        throw new IdTokenError('ID_TOKEN_BAD_ALG', 'Unsupported algorithm: ' + String(header.alg) + '.');
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
        throw new IdTokenError('ID_TOKEN_NO_KID', 'Token header has no key id.');
    }

    const jwk = await resolveKey(header.kid);
    verifySignature(parts, jwk);

    const skew = CLOCK_SKEW_SECONDS;
    const nowSec = Math.floor(now() / 1000);

    if (claims.aud !== projectId) {
        throw new IdTokenError('ID_TOKEN_BAD_AUDIENCE', 'Token audience is a different project.');
    }
    if (claims.iss !== 'https://securetoken.google.com/' + projectId) {
        throw new IdTokenError('ID_TOKEN_BAD_ISSUER', 'Token issuer is a different project.');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec - skew) {
        throw new IdTokenError('ID_TOKEN_EXPIRED', 'Token is expired.');
    }
    if (typeof claims.iat !== 'number' || claims.iat > nowSec + skew) {
        throw new IdTokenError('ID_TOKEN_BAD_ISSUED_AT', 'Token was issued in the future.');
    }
    // Owner requirement: auth_time is mandatory and must be in the past.
    if (typeof claims.auth_time !== 'number' || !Number.isFinite(claims.auth_time)) {
        throw new IdTokenError('ID_TOKEN_NO_AUTH_TIME', 'auth_time is required and must be a number.');
    }
    if (claims.auth_time > nowSec + skew) {
        throw new IdTokenError('ID_TOKEN_AUTH_TIME_FUTURE', 'auth_time is in the future.');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 128) {
        throw new IdTokenError('ID_TOKEN_BAD_SUBJECT', 'Token subject is missing or too long.');
    }
    if (claims.user_id !== undefined && claims.user_id !== claims.sub) {
        throw new IdTokenError('ID_TOKEN_SUBJECT_MISMATCH', 'sub and user_id disagree.');
    }

    return claims;
}

module.exports = {
    verifyIdToken,
    createKeyResolver,
    createDefaultFetcher,
    maxAgeFromCacheControl,
    IdTokenError,
    GOOGLE_JWKS_URL,
    ACCEPTED_ALG,
    CLOCK_SKEW_SECONDS,
};
