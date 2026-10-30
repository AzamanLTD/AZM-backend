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

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const ENVELOPE_PREFIX = 'senc';
const ENVELOPE_VERSION = 'v1';

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

function keyVersion() {
    return String(process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION || '1').trim().slice(0, 16);
}

/**
 * @param {object} payload account fields, already validated
 * @returns {string} senc:v1:<keyVersion>:<iv>:<tag>:<ciphertext> (all base64)
 */
function encryptAccountData(payload) {
    const key = encryptionKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const plaintext = JSON.stringify(payload);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        ENVELOPE_PREFIX,
        ENVELOPE_VERSION,
        keyVersion(),
        iv.toString('base64'),
        tag.toString('base64'),
        ciphertext.toString('base64'),
    ].join(':');
}

/** Parses the envelope without decrypting; used to surface the stored version. */
function parseEnvelope(envelope) {
    if (typeof envelope !== 'string') return null;
    const parts = envelope.split(':');
    if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX || parts[1] !== ENVELOPE_VERSION) return null;
    return { keyVersion: parts[2], iv: parts[3], tag: parts[4], ciphertext: parts[5] };
}

function decryptAccountData(envelope) {
    const parsed = parseEnvelope(envelope);
    if (!parsed) {
        const err = new Error('Saved service account ciphertext is malformed.');
        err.code = 'SAVED_SERVICE_CIPHERTEXT_INVALID';
        throw err;
    }
    const key = encryptionKey();
    try {
        const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parsed.iv, 'base64'));
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
    const tail = value.slice(-4);
    const dots = '•'.repeat(Math.max(0, Math.min(8, value.length - tail.length)));
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
    ENVELOPE_PREFIX,
    ENVELOPE_VERSION,
};
