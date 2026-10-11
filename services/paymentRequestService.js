// services/paymentRequestService.js
// =============================================================================
// STANDALONE PAYMENT REQUESTS — pure domain helpers.
//
// No Prisma access lives here (the controller owns the transaction and
// conditional-update boundaries); every function is pure so the validation,
// token, expiry and DTO contracts are directly unit-testable.
//
// Money rule: amounts are canonical 2-dp GHS decimal STRINGS ("12.50").
// Arithmetic happens in integer pesewas (BigInt); floats never touch the
// amount path (SS r42 exact-decimal discipline).
// =============================================================================

const crypto = require('crypto');
const { resolvePublicAppOrigin } = require('../src/config/publicAppUrl');
const {
    wrapShareToken,
    unwrapShareToken,
    isShareCryptoAvailable,
    ShareCryptoUnavailableError,
} = require('./crypto/shareToken');

// ── Amounts (exact GHS decimals) ─────────────────────────────────────────────

// Requested-amount ceiling. A request is not a money movement, but an
// unbounded "request" field is an abuse vector (billion-unit requests are
// spam at best and settlement foot-guns at worst). Documented default:
// GHS 100,000.00 per request, overridable via PAYMENT_REQUEST_MAX_GHS.
const DEFAULT_MAX_GHS = '100000';

const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

class AmountError extends Error {
    constructor(message) { super(message); this.name = 'AmountError'; }
}

/**
 * Parse a 2-dp GHS decimal string into integer pesewas (BigInt).
 * Throws AmountError on anything that is not an exact, in-range,
 * positive GHS value: non-strings (numbers are floats — inherently
 * lossy for money), malformed text, zero, negative, >2 fractional
 * digits, and amounts above the documented ceiling.
 *
 * @returns {bigint} pesewas, e.g. "12.50" -> 1250n
 */
function parseAmountToPesewas(raw) {
    if (typeof raw !== 'string') {
        throw new AmountError('amount must be an exact decimal string (e.g. "12.50").');
    }
    const value = raw.trim();
    if (!AMOUNT_PATTERN.test(value)) {
        throw new AmountError('amount must be a positive number with at most two fractional digits, e.g. "12.50".');
    }
    const [wholeRaw, fracRaw = ''] = value.split('.');
    if (wholeRaw.length > 1 && wholeRaw.startsWith('0')) {
        throw new AmountError('amount must be a positive number with at most two fractional digits, e.g. "12.50".');
    }
    const frac = (fracRaw + '00').slice(0, 2); // "5" -> "50", "50" -> "50"
    const cents = BigInt(wholeRaw) * 100n + BigInt(frac);
    if (cents <= 0n) {
        throw new AmountError('amount must be greater than zero.');
    }
    const maxGhs = (process.env.PAYMENT_REQUEST_MAX_GHS || DEFAULT_MAX_GHS).trim();
    if (!/^\d{1,9}$/.test(maxGhs)) {
        // A misconfigured ceiling must fail closed, never widen the range.
        throw new AmountError('The server amount ceiling is misconfigured; the request was not created.');
    }
    if (cents > BigInt(maxGhs) * 100n) {
        throw new AmountError(`amount must not exceed GH₵ ${maxGhs}.`);
    }
    return cents;
}

/** Canonical 2-dp string for pesewas: 1250n -> "12.50". */
function pesewasToAmountString(cents) {
    const whole = cents / 100n;
    const frac = cents % 100n;
    return `${whole}.${frac.toString().padStart(2, '0')}`;
}

/** Validate + canonicalise in one step: "12.5" -> "12.50", "0" -> AmountError. */
function normalizeAmount(raw) {
    return pesewasToAmountString(parseAmountToPesewas(raw));
}

// ── Expiry ───────────────────────────────────────────────────────────────────

// Documented default: a standalone request expires after 7 days
// (PAYMENT_REQUEST_TTL_HOURS). No existing product convention covers
// standalone money requests (trade windows are minutes; the 24h TTL in
// LinkPreviewCache is a fetch cache, not a product lifetime), so this
// default is proposed in the PR for review rather than hidden in code.
const DEFAULT_TTL_HOURS = 168;

function resolveExpiry(now = new Date()) {
    const raw = (process.env.PAYMENT_REQUEST_TTL_HOURS || String(DEFAULT_TTL_HOURS)).trim();
    const hours = Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 365) {
        // Misconfiguration fails closed: no silent default widening.
        throw new Error('PAYMENT_REQUEST_TTL_HOURS must be an integer between 1 and 8760.');
    }
    return new Date(now.getTime() + hours * 3600 * 1000);
}

// ── LINK share tokens ────────────────────────────────────────────────────────
//
// WHOLE-ROW PERSISTENCE MODEL (must stay accurate everywhere it is stated):
//   • RAW token: 32 CSPRNG bytes (base64url) — MEMORY ONLY, never stored,
//     never logged, never echoed.
//   • PaymentRequest.tokenHash: ONLY sha256(raw token), unique — the sole
//     durable form of the token, and it is a one-way hash.
//   • The share URL carries the raw token as an AES-256-GCM envelope
//     (services/crypto/shareToken.js, ENCRYPTION_KEY via fieldCipher), so
//     the §r42 replay truth (FinancialOperation.responseBody, a permanent
//     plaintext column) holds ciphertext, never a usable bearer token.
//     No unencrypted durable field anywhere holds the raw token.
//   • The public route unwraps (AEAD-verified) and resolves by sha256(raw);
//     tampered envelopes are indistinguishable from unknown tokens (404).
//   • Fail-closed in EVERY environment: no usable ENCRYPTION_KEY → LINK
//     create and public resolution refuse with 503, nothing persisted.
function mintLinkToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Build the canonical server-issued share URL. Fails honestly if unset. */
function buildShareUrl(urlToken) {
    const origin = resolvePublicAppOrigin();
    if (!origin.ok) {
        const err = new Error(origin.message);
        err.code = 'PUBLIC_APP_URL_UNCONFIGURED';
        throw err;
    }
    return `${origin.origin}/request/${urlToken}`;
}

/**
 * Mint a LINK share: raw token (memory only), its sha256 hash (the only
 * durable token form), and the canonical share URL whose token segment is
 * the AEAD envelope of the raw token (ciphertext safe to persist in the
 * idempotency replay bytes). Throws ShareCryptoUnavailableError when the
 * share-token key is unusable — the caller must fail closed (503).
 */
function mintLinkShare() {
    const raw = mintLinkToken();
    const urlToken = wrapShareToken(raw); // throws ShareCryptoUnavailableError
    return {
        tokenHash: hashToken(raw),
        urlToken,
        shareUrl: buildShareUrl(urlToken),
    };
}

/**
 * Resolve the share-URL token segment (an AEAD envelope) to the sha256 hash
 * used for lookup. Returns null for malformed/tampered/unknown envelopes
 * (caller 404s). Throws ShareCryptoUnavailableError when the key is
 * unusable (caller 503s — a config failure is never a "not found").
 */
function resolveLinkTokenHash(urlToken) {
    const raw = unwrapShareToken(urlToken);
    if (!raw) return null;
    return hashToken(raw);
}

// ── Status projection ─────────────────────────────────────────────────────────

const PENDING = 'PENDING';
const CANCELLED = 'CANCELLED';
const DECLINED = 'DECLINED';
const EXPIRED = 'EXPIRED';

/**
 * Server-side terminal projection: a PENDING request past its expiresAt is
 * EXPIRED — enforced here (reads) and in every transition guard, never left
 * to the UI. Stored statuses stay PENDING/CANCELLED/DECLINED; EXPIRED is a
 * projection so a clock skew or sweeper outage can never strand a request
 * in a stored-but-unreachable state.
 */
function projectStatus(row, now = new Date()) {
    if (row.status === PENDING && row.expiresAt.getTime() <= now.getTime()) {
        return EXPIRED;
    }
    return row.status;
}

// ── DTO builders ──────────────────────────────────────────────────────────────

function displayNameOf(user) {
    if (!user) return null;
    return (user.displayName && user.displayName.trim()) ||
        (user.username && user.username.trim()) ||
        null;
}

function personDto(user) {
    if (!user) return null;
    return {
        displayName: displayNameOf(user),
        username: user.username,
    };
}

/**
 * List DTO — only what the inbox/outbox UI needs. Privacy rules:
 *   • never tokenHash or any token material (raw or envelope);
 *   • the canonical share URL is NEVER in list responses, for anyone: the
 *     raw token is not stored anywhere (only its sha256 hash and its AEAD
 *     envelope inside the one-time create response), so the server cannot
 *     rebuild it. Product contract: the share URL is delivered ONCE, at
 *     creation; a lost link is recovered by cancelling and re-creating.
 *     (Documented in the PR body — do not "fix" this in the UI by
 *     reintroducing token persistence.)
 */
function toListItem(row, { viewerIsRequester }) {
    const dto = {
        id: row.id,
        amount: row.amountExact,
        currency: row.currency,
        status: projectStatus(row),
        mode: row.mode,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        resolvedAt: row.resolvedAt,
        requester: personDto(row.requester),
        recipient: personDto(row.recipient),
        requesterDisplayName: displayNameOf(row.requester),
        recipientDisplayName: displayNameOf(row.recipient),
    };
    if (viewerIsRequester && row.mode === 'LINK' && row.status === PENDING) {
        // Rebuildable only when the raw token is known: for outgoing rows we
        // cannot (token is never stored), so link details are NOT included
        // here — the requester already holds the share URL from creation.
        // (Kept explicit: no token, no shareUrl fabrication.)
    }
    return dto;
}

/**
 * Public landing DTO for /request/:token (unauthenticated). Minimal by
 * contract: requester DISPLAY info only — no email, phone, azamanId,
 * balance, auth data, or recipient identity. No raw token echo, no hash.
 */
function toPublicDto(row) {
    return {
        id: row.id,
        amount: row.amountExact,
        currency: row.currency,
        status: projectStatus(row),
        mode: row.mode,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        requester: personDto(row.requester),
        requesterDisplayName: displayNameOf(row.requester),
    };
}

// ── Cursor pagination (stable, bounded) ───────────────────────────────────────

function encodeCursor(createdAt, id) {
    return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512) {
        return null;
    }
    let decoded;
    try {
        decoded = Buffer.from(cursor, 'base64').toString('utf8');
    } catch {
        return null;
    }
    const sep = decoded.lastIndexOf('|');
    if (sep <= 0) return null;
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
}

module.exports = {
    AmountError,
    parseAmountToPesewas,
    pesewasToAmountString,
    normalizeAmount,
    resolveExpiry,
    mintLinkToken,
    hashToken,
    buildShareUrl,
    mintLinkShare,
    resolveLinkTokenHash,
    isShareCryptoAvailable,
    ShareCryptoUnavailableError,
    projectStatus,
    toListItem,
    toPublicDto,
    displayNameOf,
    encodeCursor,
    decodeCursor,
    PENDING,
    CANCELLED,
    DECLINED,
    EXPIRED,
    DEFAULT_MAX_GHS,
    DEFAULT_TTL_HOURS,
};
