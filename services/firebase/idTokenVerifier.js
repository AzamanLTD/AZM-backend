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
// PARITY WITH FIREBASE ADMIN 14.3.0 - verified by reading the installed
// library, not assumed (node_modules/firebase-admin/lib/auth/token-verifier.js
// and lib/utils/jwt.js):
//   - alg: RS256 only, refused otherwise, pinned BEFORE any key lookup. Same
//     as firebase-admin (token-verifier.js:213). Covers 'none' and HS*.
//   - kid: required on every non-emulator token (token-verifier.js:197).
//   - aud: must equal the project id (token-verifier.js:219).
//   - iss: must equal https://securetoken.google.com/{project} (:230).
//   - sub: a non-empty string of at most 128 characters (:237-243).
//   - exp: delegated to jsonwebtoken's jwt.verify with NO options, so
//     clockTolerance is jsonwebtoken's default of ZERO (lib/utils/jwt.js:258).
//     Production therefore tolerates no clock skew at all and this file matches
//     that exactly (EXP_SKEW_SECONDS = 0). An earlier draft of this file used a
//     300s window on the mistaken belief that firebase-admin set
//     CLOCK_SKEW_SECS; that constant does not exist in 14.3.0.
//   - iat and auth_time: firebase-admin checks NEITHER (zero occurrences of
//     auth_time in token-verifier.js). Both checks here are additions, i.e.
//     strictly stricter than production, documented as such:
//       * auth_time is mandatory and must not be in the future (owner rule),
//         with IAT_TOLERANCE_SECONDS of slack so ordinary clock drift on an
//         issuing device cannot cause a false rejection.
//       * iat must not be in the future beyond the same tolerance.
//   - Emulator bypass: firebase-admin skips the alg and kid checks when
//     FIREBASE_AUTH_EMULATOR_HOST is set. This file has no such bypass; a
//     production cutover must never run against an emulator origin.
//   - getAuth().verifyIdToken(idToken, true) (revocation check) is NOT
//     replicated: it needs a live identitytoolkit call. Callers relying on it
//     must keep doing so.
// =============================================================================

const crypto = require('crypto');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// Expiry parity: jsonwebtoken's default clockTolerance is 0 and firebase-admin
// passes no options, so production accepts no skew. Verified, not assumed.
const EXP_SKEW_SECONDS = 0;
// Added by this file (firebase-admin checks neither claim). Slack for ordinary
// clock drift, never a bypass: a token from the future beyond this is refused.
const IAT_TOLERANCE_SECONDS = 60;
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

// Google's own key sets are RS256 RSA keys of at least 2048 bits. Anything
// else is either malformed or not a key this verifier should trust, and a set
// containing such an entry is refused in full rather than partially trusted:
// silently dropping entries could mean verifying against a reduced key set that
// no longer represents what the issuer actually publishes.
const MIN_RSA_MODULUS_BITS = 2048;
const REQUIRED_USE = 'sig';

function assertWellFormedKey(entry, index) {
    const where = 'key[' + index + ']';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' is not an object.');
    }
    if (typeof entry.kid !== 'string' || entry.kid.trim().length === 0) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' has no usable kid.');
    }
    if (entry.kty !== 'RSA') {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' is not an RSA key.');
    }
    if (typeof entry.n !== 'string' || typeof entry.e !== 'string' || entry.n.length === 0 || entry.e.length === 0) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' has no usable modulus or exponent.');
    }
    // Declared usage and algorithm must both be signing/RS256. A key published
    // for encryption must never be used to check a login signature.
    if (entry.use !== REQUIRED_USE) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' is not published for signing.');
    }
    if (entry.alg !== ACCEPTED_ALG) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' is not an RS256 key.');
    }
    let modulusBits;
    try {
        const key = crypto.createPublicKey({ key: { kty: entry.kty, n: entry.n, e: entry.e }, format: 'jwk' });
        modulusBits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    } catch (err) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' is not a constructible RSA public key.');
    }
    if (typeof modulusBits !== 'number' || modulusBits < MIN_RSA_MODULUS_BITS) {
        throw new IdTokenError('JWKS_MALFORMED_KEY', where + ' has a modulus below ' + MIN_RSA_MODULUS_BITS + ' bits.');
    }
    return entry;
}

/** Validates every entry, rejects duplicate kids, and refuses an empty set. */
function normalizeKeySet(rawKeys) {
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        throw new IdTokenError('JWKS_EMPTY', 'Key set contains no keys.');
    }
    const seen = new Map();
    const valid = rawKeys.map((entry, index) => {
        const key = assertWellFormedKey(entry, index);
        if (seen.has(key.kid)) {
            // Two keys under one kid make the choice of verification key
            // ambiguous, which is exactly what a substitution attack wants.
            throw new IdTokenError('JWKS_AMBIGUOUS_KEY', 'Key set has more than one key for kid ' + key.kid + '.');
        }
        seen.set(key.kid, true);
        return key;
    });
    return valid;
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
            keys = normalizeKeySet(doc.keys);
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

    const nowSec = Math.floor(now() / 1000);

    if (claims.aud !== projectId) {
        throw new IdTokenError('ID_TOKEN_BAD_AUDIENCE', 'Token audience is a different project.');
    }
    if (claims.iss !== 'https://securetoken.google.com/' + projectId) {
        throw new IdTokenError('ID_TOKEN_BAD_ISSUER', 'Token issuer is a different project.');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec - EXP_SKEW_SECONDS) {
        throw new IdTokenError('ID_TOKEN_EXPIRED', 'Token is expired.');
    }
    if (typeof claims.iat !== 'number' || claims.iat > nowSec + IAT_TOLERANCE_SECONDS) {
        throw new IdTokenError('ID_TOKEN_BAD_ISSUED_AT', 'Token was issued in the future.');
    }
    // Owner requirement: auth_time is mandatory and must be in the past.
    if (typeof claims.auth_time !== 'number' || !Number.isFinite(claims.auth_time)) {
        throw new IdTokenError('ID_TOKEN_NO_AUTH_TIME', 'auth_time is required and must be a number.');
    }
    if (claims.auth_time > nowSec + IAT_TOLERANCE_SECONDS) {
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
    normalizeKeySet,
    MIN_RSA_MODULUS_BITS,
    IdTokenError,
    GOOGLE_JWKS_URL,
    ACCEPTED_ALG,
    EXP_SKEW_SECONDS,
    IAT_TOLERANCE_SECONDS,
};
