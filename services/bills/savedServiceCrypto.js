// services/bills/savedServiceCrypto.js
// =============================================================================
// Field-level protection for saved service accounts.
//
// Deliberately separate from services/crypto/fieldCipher.js: that service may
// fall back to plaintext outside production, which is unacceptable for meter
// numbers and account references. This one NEVER writes plaintext — if the key
// is missing or malformed it throws, in every environment.
//
// Two independent keys, on purpose:
//   SAVED_SERVICE_ENCRYPTION_KEY   AES-256-GCM confidentiality
//   SAVED_SERVICE_FINGERPRINT_KEY  HMAC-SHA256 duplicate detection
// A single key for both would let a fingerprint leak become a decryption oracle.
// =============================================================================

/*
 * FINGERPRINT-KEY ROTATION IS A SEPARATE PROBLEM FROM ENCRYPTION-KEY ROTATION.
 *
 * The encryption key ring above lets old ciphertext keep decrypting after a
 * rotation. It does nothing for fingerprints: the fingerprint is an HMAC keyed
 * by SAVED_SERVICE_FINGERPRINT_KEY, and changing that key changes every
 * computed value. Existing rows keep their old fingerprints, so a re-saved
 * account would no longer match its stored record, duplicate detection would
 * silently stop working, and the same meter could be saved twice.
 *
 * Therefore: DO NOT rotate the fingerprint key on its own. A rotation requires
 * a migration that recomputes every accountFingerprint from decrypted account
 * data using the new key, inside a single transaction, with the old key still
 * available. Until that migration exists and has been rehearsed, treat the
 * fingerprint key as fixed.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const ENVELOPE_PREFIX = 'senc';
// v1 encrypted the payload alone. v2 additionally binds the ciphertext to the
// owning member and service through AES-GCM AAD, so a row copied onto another
// member's account (a bad migration, a replication mix-up, an operator with
// database write access) fails authentication instead of decrypting into the
// wrong tenant's UI.
const ENVELOPE_VERSION_LEGACY = 'v1';
const ENVELOPE_VERSION = 'v2';
const SUPPORTED_ENVELOPE_VERSIONS = new Set([ENVELOPE_VERSION_LEGACY, ENVELOPE_VERSION]);
// Key-version names are envelope segments: a colon would add a field, so the
// alphabet is deliberately narrow.
const VERSION_RE = /^[A-Za-z0-9_-]{1,16}$/;

function assertVersionName(value, label) {
    const name = String(value == null ? '' : value).trim();
    if (!VERSION_RE.test(name)) {
        const err = new Error(`${label} must match ${VERSION_RE} (got ${JSON.stringify(value)}).`);
        err.code = 'SAVED_SERVICE_KEY_INVALID';
        throw err;
    }
    return name;
}

function aadFor(identity) {
    const userId = identity && identity.userId != null ? String(identity.userId) : '';
    const serviceCode = identity && identity.serviceCode ? String(identity.serviceCode) : '';
    if (!userId || !serviceCode) {
        // Fail closed: an unbound envelope is exactly the weakness v2 removes.
        const err = new Error('Saved service account data must be bound to a member and service.');
        err.code = 'SAVED_SERVICE_IDENTITY_REQUIRED';
        throw err;
    }
    return Buffer.from(`saved-service-account|${userId}|${serviceCode}`, 'utf8');
}

function _decodeKey(raw, name) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        const err = new Error(`${name} is not set. Refusing to store saved service account data.`);
        err.code = 'SAVED_SERVICE_KEY_MISSING';
        throw err;
    }
    const trimmed = raw.trim();
    let buf;
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        buf = Buffer.from(trimmed, 'hex');
    } else {
        buf = Buffer.from(trimmed, 'base64');
    }
    if (buf.length !== 32) {
        const err = new Error(`${name} must decode to exactly 32 bytes (got ${buf.length}).`);
        err.code = 'SAVED_SERVICE_KEY_INVALID';
        throw err;
    }
    return buf;
}

function encryptionKey() {
    return _decodeKey(process.env.SAVED_SERVICE_ENCRYPTION_KEY, 'SAVED_SERVICE_ENCRYPTION_KEY');
}

function fingerprintKey() {
    return _decodeKey(process.env.SAVED_SERVICE_FINGERPRINT_KEY, 'SAVED_SERVICE_FINGERPRINT_KEY');
}

/**
 * Key ring: the configured key is the CURRENT version, and older versions may
 * be supplied as JSON so ciphertext written before a rotation still opens.
 * Format: SAVED_SERVICE_ENCRYPTION_KEYS_JSON={"0":"<hex or base64 32B>"}
 */
function keyRing() {
    const ring = {};
    const current = keyVersion();
    ring[current] = encryptionKey();
    const extra = process.env.SAVED_SERVICE_ENCRYPTION_KEYS_JSON;
    if (extra) {
        let parsed;
        try {
            parsed = JSON.parse(extra);
        } catch (_e) {
            const err = new Error('SAVED_SERVICE_ENCRYPTION_KEYS_JSON is not valid JSON.');
            err.code = 'SAVED_SERVICE_KEY_INVALID';
            throw err;
        }
        for (const [version, material] of Object.entries(parsed || {})) {
            const name = assertVersionName(version, 'SAVED_SERVICE_ENCRYPTION_KEYS_JSON version');
            if (Object.prototype.hasOwnProperty.call(ring, name)) {
                // A historical entry naming the CURRENT version would silently
                // replace the live encryption key and orphan every row.
                const err = new Error(
                    `SAVED_SERVICE_ENCRYPTION_KEYS_JSON repeats version "${name}"; `
                    + 'historical keys must use distinct version names.',
                );
                err.code = 'SAVED_SERVICE_KEY_DUPLICATE_VERSION';
                throw err;
            }
            ring[name] = _decodeKey(material, `keys.${name}`);
        }
    }
    return ring;
}

function resolveKey(version) {
    const key = keyRing()[String(version)];
    if (!key) {
        // Fail closed: an unknown version is a rotation mistake, never a
        // reason to try the current key and hope.
        const err = new Error(`No saved-service key for version ${version}.`);
        err.code = 'SAVED_SERVICE_KEY_VERSION_UNKNOWN';
        throw err;
    }
    return key;
}

function keyVersion() {
    // Validated, never truncated: a silently shortened or colon-bearing name
    // would corrupt the colon-delimited envelope.
    return assertVersionName(process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION ?? '1',
        'SAVED_SERVICE_ENCRYPTION_KEY_VERSION');
}

/**
 * @param {object} payload account fields, already validated
 * @returns {string} senc:v2:<keyVersion>:<iv>:<tag>:<ciphertext> (all base64)
 *   v2 binds the ciphertext to userId + serviceCode through AAD; v1 envelopes
 *   (no binding) still decrypt so pre-rotation rows keep working.
 */
function encryptAccountData(payload, identity) {
    const version = keyVersion();
    const aad = aadFor(identity);
    // Resolve through the ring so a malformed rotation configuration fails
    // HERE, before a row exists, instead of at the first later read.
    const key = resolveKey(version);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    cipher.setAAD(aad);
    const plaintext = JSON.stringify(payload);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        ENVELOPE_PREFIX,
        ENVELOPE_VERSION,
        version,
        iv.toString('base64'),
        tag.toString('base64'),
        ciphertext.toString('base64'),
    ].join(':');
}

/** Parses the envelope without decrypting; used to surface the stored version. */
function parseEnvelope(envelope) {
    if (typeof envelope !== 'string') return null;
    const parts = envelope.split(':');
    if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX) return null;
    if (!SUPPORTED_ENVELOPE_VERSIONS.has(parts[1])) return null;
    return { envelopeVersion: parts[1], keyVersion: parts[2], iv: parts[3], tag: parts[4], ciphertext: parts[5] };
}

function decryptAccountData(envelope, identity) {
    const parsed = parseEnvelope(envelope);
    if (!parsed) {
        const err = new Error('Saved service account ciphertext is malformed.');
        err.code = 'SAVED_SERVICE_CIPHERTEXT_INVALID';
        throw err;
    }
    const key = resolveKey(parsed.keyVersion);
    try {
        const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parsed.iv, 'base64'));
        if (parsed.envelopeVersion === ENVELOPE_VERSION) {
            decipher.setAAD(aadFor(identity));
        }
        decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
            decipher.final(),
        ]).toString('utf8');
        return JSON.parse(plaintext);
    } catch (cause) {
        const err = new Error('Saved service account ciphertext failed authentication.');
        err.code = 'SAVED_SERVICE_CIPHERTEXT_INVALID';
        throw err;
    }
}

/**
 * Keyed, deterministic fingerprint. Deterministic so duplicates are detectable;
 * keyed so the value cannot be recomputed by someone who only has the identifier.
 * The identity MUST already be canonicalised by the caller.
 */
function accountFingerprint({ userId, serviceCode, providerCode, identity }) {
    const key = fingerprintKey();
    const material = `${userId}|${serviceCode}|${providerCode}|${identity}`;
    return crypto.createHmac('sha256', key).update(material, 'utf8').digest('hex');
}

/**
 * Display mask. Keeps a short tail so a member can tell two meters apart
 * without the value being usable.
 */
function maskIdentity(identity) {
    const value = String(identity);
    // Short identifiers are masked ENTIRELY. Keeping a 4-character tail of a
    // 4-character reference returns the reference itself, which is a leak, not
    // a mask. Only genuinely long identifiers keep a tail.
    if (value.length < 10) {
        return '•'.repeat(Math.max(3, value.length)).slice(0, 32);
    }
    const tail = value.slice(-4);
    const dots = '•'.repeat(Math.max(4, Math.min(8, value.length - tail.length)));
    return `${dots}${tail}`.slice(0, 32);
}

/** True when both keys are present, decodable and 32 bytes. */
function isConfigured() {
    try {
        encryptionKey();
        fingerprintKey();
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    encryptAccountData,
    decryptAccountData,
    parseEnvelope,
    accountFingerprint,
    maskIdentity,
    isConfigured,
    keyVersion,
    keyRing,
    resolveKey,
    ENVELOPE_PREFIX,
    ENVELOPE_VERSION,
};
