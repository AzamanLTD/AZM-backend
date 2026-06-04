// services/identity/phoneHash.js
// =============================================================================
// Phone-number hashing for privacy-preserving Contact_Discovery (Phase 6).
//
// Contact discovery must never match a caller's raw address-book numbers
// directly against stored plaintext. Instead we hash every number with a
// server-side pepper (SHA-256) and match hash-to-hash. The submitted numbers
// are hashed in-memory for the duration of the request and never persisted;
// the only stored derivative is `User.phoneHash`, set when a user verifies
// their phone.
//
// Pepper: PHONE_HASH_PEPPER env var (falls back to JWT_SECRET so the feature
// works out-of-the-box; set a dedicated pepper in prod for key separation).
// Changing the pepper invalidates existing hashes — re-run the backfill if
// you rotate it.
// =============================================================================

const crypto = require('crypto');

function _pepper() {
  return process.env.PHONE_HASH_PEPPER || process.env.JWT_SECRET || 'azaman-phone-pepper';
}

// Normalize a raw phone string to E.164-ish (+ then 7..15 digits) or null.
function normalizeE164(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  const candidate = `+${s}`;
  return /^\+\d{7,15}$/.test(candidate) ? candidate : null;
}

// SHA-256(normalizedE164 + pepper) → hex. Returns null for un-normalizable
// input so callers can drop junk before it reaches a query.
function hashPhone(raw) {
  const normalized = normalizeE164(raw);
  if (!normalized) return null;
  return crypto
    .createHmac('sha256', _pepper())
    .update(normalized)
    .digest('hex');
}

module.exports = { hashPhone, normalizeE164 };
