// services/crypto/shareToken.js
// =============================================================================
// URL-safe AEAD envelope for LINK share tokens.
//
// Layered STRICTLY on services/crypto/fieldCipher.js — the repository's
// field-level authenticated-encryption service (AES-256-GCM, key from
// ENCRYPTION_KEY, production fail-closed) — so key management, envelope
// versioning and failure semantics stay identical to the audited KYC
// idNumber path. This module adds ONLY URL-safe transcoding of the same
// envelope; it introduces no new key, algorithm or trust decision.
//
// WHY IT EXISTS:
// The LINK share URL is delivered inside the create response, and the §r42
// idempotency authority PERSISTS that exact response as the replay truth
// (FinancialOperation.responseBody — a permanent, UNENCRYPTED column).
// Serving the raw bearer token in that response would store a usable
// money-request capability in plaintext at rest. Instead, the URL token
// segment is the raw token wrapped in authenticated encryption:
//
//   • The RAW token (32 CSPRNG bytes, base64url) exists ONLY in memory.
//   • PaymentRequest.tokenHash stores ONLY sha256(raw token) — lookup only.
//   • FinancialOperation.responseBody stores ONLY the ciphertext envelope
//     (the share URL as the client received it — ciphertext, not a secret).
//   • The public route unwraps the envelope (AEAD-verified) and resolves by
//     sha256(raw); a tampered envelope fails authentication and is treated
//     EXACTLY like an unknown token (404, no oracle).
//   • A committed replay re-emits the stored bytes verbatim — still only
//     ciphertext at rest — so the §r42 byte-identical replay and
//     exactly-once contracts are untouched by this design.
//
// Wire format (URL-safe, no ':' '/' '+' '=' so it survives path params):
//   encu1.<iv_b64url>.<authTag_b64url>.<ciphertext_b64url>
// (the base64url transcoding of fieldCipher's `enc:v1:<iv>:<tag>:<ct>`).
//
// FAIL-CLOSED (ALL environments, not just production): without a usable
// ENCRYPTION_KEY, LINK create and public link resolution are REFUSED with
// 503 LINK_SHARE_CRYPTO_UNCONFIGURED — a plaintext share token must never
// be persisted or served to make things convenient, and a half-usable link
// must never be minted. The routes enforce this BEFORE the idempotency
// claim is created (pre-claim guard), so a misconfigured server leaves no
// claim residue and no request row.
// =============================================================================

const fieldCipher = require('./fieldCipher');

const PREFIX = 'encu1.';
const SEGMENT_COUNT = 3; // iv, authTag, ciphertext
const B64URL = /^[A-Za-z0-9_-]+$/;

class ShareCryptoUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ShareCryptoUnavailableError';
        this.code = 'LINK_SHARE_CRYPTO_UNCONFIGURED';
    }
}

/** True iff a usable 32-byte ENCRYPTION_KEY is configured. */
function isShareCryptoAvailable() {
    return fieldCipher.isKeyAvailable();
}

/**
 * Wrap a raw share token into the URL-safe AEAD envelope.
 * THROWS ShareCryptoUnavailableError when no usable key is configured
 * (fail-closed in every environment — no plaintext token may be served).
 */
function wrapShareToken(rawToken) {
    if (!isShareCryptoAvailable()) {
        throw new ShareCryptoUnavailableError(
            'Link share-token encryption is not configured (ENCRYPTION_KEY missing or invalid). ' +
            'No link request can be created and no token material was stored.');
    }
    // fieldCipher.encrypt → `enc:v1:<iv>:<tag>:<ct>` (standard base64).
    const envelope = fieldCipher.encrypt(String(rawToken));
    if (!fieldCipher.isEncrypted(envelope)) {
        // Cannot happen with a usable key, but never mint a plaintext URL.
        throw new ShareCryptoUnavailableError(
            'Link share-token encryption failed to produce an encrypted envelope. Nothing was served.');
    }
    const segments = envelope.split(':').slice(2)
        .map((s) => Buffer.from(s, 'base64').toString('base64url'));
    return PREFIX + segments.join('.');
}

/**
 * Unwrap the URL-safe envelope back to the raw token.
 *   • Malformed / non-envelope / tampered input → null (indistinguishable
 *     from an unknown token; the public route 404s — no oracle).
 *   • No usable key → THROWS ShareCryptoUnavailableError (the route 503s —
 *     a config failure must not masquerade as "link not found").
 */
function unwrapShareToken(wrapped) {
    if (typeof wrapped !== 'string' || !wrapped.startsWith(PREFIX)) return null;
    const segments = wrapped.slice(PREFIX.length).split('.');
    if (segments.length !== SEGMENT_COUNT) return null;
    if (!segments.every((s) => s.length > 0 && B64URL.test(s))) return null;

    if (!isShareCryptoAvailable()) {
        throw new ShareCryptoUnavailableError(
            'Link share-token encryption is not configured (ENCRYPTION_KEY missing or invalid). ' +
            'Links cannot be resolved.');
    }

    const b64 = segments.map((s) => Buffer.from(s, 'base64url').toString('base64'));
    const envelope = ['enc', 'v1', ...b64].join(':');
    try {
        return fieldCipher.decrypt(envelope); // AEAD-authenticated; throws on tamper
    } catch (_) {
        return null; // tampered ciphertext, wrong key, malformed envelope → unknown link
    }
}

module.exports = {
    isShareCryptoAvailable,
    wrapShareToken,
    unwrapShareToken,
    ShareCryptoUnavailableError,
};
