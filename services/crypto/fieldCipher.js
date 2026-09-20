// services/crypto/fieldCipher.js
// =============================================================================
// Field-level AES-256-GCM encryption for sensitive columns at rest
// (Phase 5 / Workstream A — 2026-06-01).
//
// Used to encrypt the KYC `idNumber` (a government identity number) so a
// database dump or read-replica leak does not expose raw identity numbers.
// Decryption happens only in admin-authorized read paths.
//
// Wire format (single self-identifying string, all segments base64):
//   enc:v1:<iv>:<authTag>:<ciphertext>
//
// Design properties:
//   • Self-identifying — `isEncrypted()` / `decrypt()` recognise the
//     `enc:v1:` prefix, so legacy plaintext values pass through untouched.
//     This makes the rollout backward-compatible: old rows decrypt to
//     themselves until the backfill re-writes them.
//   • Idempotent — `encrypt()` returns an already-encrypted value as-is,
//     so re-running the backfill or double-wrapping is safe.
//   • PRODUCTION FAIL-CLOSED — in NODE_ENV=production a missing or invalid
//     ENCRYPTION_KEY makes encrypt() THROW (the KYC write is refused; the
//     user stays PENDING; no government identifier ever lands plaintext).
//     Local/test ergonomics are preserved: outside production a missing key
//     passes the plaintext through with a one-time warning. decrypt() of a
//     real ciphertext WITHOUT a key always throws (never silent garbage).
//
// Key: ENCRYPTION_KEY env var — 32 bytes, provided as 64-hex-char or
// base64 (44-char). Generate with:
//   node -e "logger.info(require('crypto').randomBytes(32).toString('hex'))"
// =============================================================================

const crypto = require('crypto');

const logger = require('../../src/config/logger');
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

let _warned = false;

function _resolveKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  let buf;
  // Accept hex (64 chars) or base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    buf = Buffer.from(raw.trim(), 'hex');
  } else {
    buf = Buffer.from(raw.trim(), 'base64');
  }
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
      'Provide 64 hex chars or a 32-byte base64 string.',
    );
  }
  return buf;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * True when a valid 32-byte ENCRYPTION_KEY is configured. Boot paths and
 * KYC preflight guards use this to fail closed BEFORE accepting sensitive
 * input in production.
 */
function isKeyAvailable() {
  try {
    return _resolveKey() !== null;
  } catch {
    return false; // present but INVALID (wrong length/format) — also fail closed
  }
}

/**
 * Encrypt a plaintext string. Returns the `enc:v1:…` envelope. Idempotent
 * (already-encrypted input is returned unchanged). Null/empty passes through.
 *
 * PRODUCTION CONTRACT: in NODE_ENV=production a missing or invalid
 * ENCRYPTION_KEY THROWS — live KYC must never write a government
 * identifier plaintext because of server misconfiguration. The KYC service
 * refuses the verification and the user stays PENDING; the write simply does
 * not happen. Outside production the historical fail-soft passthrough is
 * preserved for local/test ergonomics.
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // idempotent — never throws: no NEW plaintext is written

  let key = null;
  let keyError = null;
  try {
    key = _resolveKey();
  } catch (e) {
    keyError = e; // invalid key format — production must fail closed on this too
  }

  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[fieldCipher] SENSITIVE-FIELD WRITE REFUSED: ENCRYPTION_KEY is ' +
        (keyError ? `invalid (${keyError.message})` : 'not set') +
        '. Live KYC cannot store government identifiers in plaintext — ' +
        'fix the production configuration. The write did not happen.',
      );
    }
    if (!_warned) {
      logger.warn(
        '[fieldCipher] ENCRYPTION_KEY not set — sensitive fields are stored ' +
        'in PLAINTEXT (non-production fail-soft). Set ENCRYPTION_KEY to ' +
        'enable at-rest encryption.',
      );
      _warned = true;
    }
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'enc',
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/**
 * Decrypt an `enc:v1:…` envelope back to plaintext. A value that is NOT
 * encrypted (legacy plaintext or null) is returned unchanged. Throws if a
 * real ciphertext is supplied but ENCRYPTION_KEY is missing/wrong.
 */
function decrypt(value) {
  if (value == null || value === '') return value;
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough

  const key = _resolveKey();
  if (!key) {
    throw new Error('[fieldCipher] cannot decrypt: ENCRYPTION_KEY not set.');
  }

  const parts = value.split(':');
  // ['enc','v1', iv, tag, ct]
  if (parts.length !== 5) {
    throw new Error('[fieldCipher] malformed ciphertext envelope.');
  }
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ct = Buffer.from(parts[4], 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Decrypt without throwing — returns null on failure. Useful for read
 * paths that prefer to degrade gracefully (e.g. show "—" instead of 500).
 */
function tryDecrypt(value) {
  try {
    return decrypt(value);
  } catch (_) {
    return null;
  }
}

/** True iff a usable ENCRYPTION_KEY is configured. */
function isConfigured() {
  try {
    return _resolveKey() != null;
  } catch (_) {
    return false;
  }
}

module.exports = {
  isKeyAvailable, encrypt, decrypt, tryDecrypt, isEncrypted, isConfigured };
