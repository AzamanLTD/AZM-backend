'use strict';

// =============================================================================
// §WP-I — CANONICAL PROVIDER-OBSERVATION IDENTITY
//
// ONE provider payment must resolve to ONE identity, no matter which Moolre
// endpoint observed it, which funding type it was queried as, or which code path
// is looking at it. The treasury-witness path and the customer-deposit path
// previously hashed DIFFERENT things (the witness included fundingType and
// endpoint; the deposit path used the merchant reference), so the same payment
// could present as two different observations and be consumed twice.
//
// WHAT IDENTIFIES A PAYMENT
// The merchant-issued `externalref`. Evidence that it is globally unique rather
// than account-scoped, from this repository's provider contract:
//   * docs/MOOLRE_BANK_PAYOUT_CONTRACT.md records `DUPLICATE_REFERENCE` —
//     "Moolre already holds this externalref" — as a provider-level rejection,
//     not a per-account one; the provider rejects a reference it already holds.
//   * the collection reference is Azaman's own `txHash`/referenceId sent
//     verbatim (`"externalref": "<Azaman referenceId, verbatim>"`), generated
//     per deposit, so two different accounts cannot legitimately share one.
// Account is therefore NOT part of the key. It is carried alongside it and a
// same-key/different-account collision is refused for operator review rather
// than silently merged — the guard neither weakens nor silently broadens.
//
// The key is derived ONLY from validated provider data and trusted config. It
// never includes a caller-supplied amount, currency, customer or account.
// =============================================================================

const SUPPORTED_PROVIDERS = Object.freeze(['moolre']);

class ObservationIdentityError extends Error {
    constructor(code, message, detail = {}) {
        super(message);
        this.name = 'ObservationIdentityError';
        this.code = code;
        this.detail = detail;
    }
}

/** Kinds of economic use that can hold a claim. */
const CLAIM_PURPOSE = Object.freeze({
    CUSTOMER_DEPOSIT: 'CUSTOMER_DEPOSIT',
    TREASURY_WITNESS: 'TREASURY_WITNESS',
});

/** Trim only. Case, inner whitespace and punctuation are identity. */
function normalizeReference(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
    if (typeof raw !== 'string') return null;
    const ref = raw.trim();
    if (!ref) return null;
    if (ref.length > 200) return null;      // a reference is never a payload
    if (/[\u0000-\u001f]/.test(ref)) return null;
    return ref;
}

function normalizeProvider(raw) {
    const p = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return SUPPORTED_PROVIDERS.includes(p) ? p : null;
}

/**
 * Canonical identity of one provider observation.
 *
 * @returns {{ observationKey: string, provider: string, reference: string, accountKey: string|null }}
 * @throws  ObservationIdentityError when the observation cannot identify itself.
 *          Callers must fail closed: an unidentifiable observation must never be
 *          economically consumed.
 */
function canonicalObservationIdentity({ provider, reference, accountNumber = null } = {}) {
    const p = normalizeProvider(provider);
    if (!p) {
        throw new ObservationIdentityError(
            'OBSERVATION_PROVIDER_UNSUPPORTED',
            '[wp-i] the provider on this observation is not a supported collection provider',
            { provider: provider ?? null },
        );
    }
    const ref = normalizeReference(reference);
    if (!ref) {
        throw new ObservationIdentityError(
            'OBSERVATION_REFERENCE_MISSING',
            '[wp-i] this provider observation carries no usable payment reference, so it cannot be claimed',
            { provider: p },
        );
    }
    const accountRaw = typeof accountNumber === 'string' ? accountNumber.trim() : '';
    return {
        observationKey: `${p}|collection|${ref}`,
        provider: p,
        reference: ref,
        accountKey: accountRaw ? accountRaw : null,
    };
}

/** Histories that are not a legitimate claim by either path. */
const QUARANTINE_PURPOSE = 'QUARANTINE';


// =============================================================================
// §WP-I v2 — WALLET-SCOPED OBSERVATION IDENTITY
//
// The v1 key (`moolre|collection|<ref>`) assumed the merchant external
// reference is GLOBALLY unique. Moolre's own quickstart states `externalref`
// must be unique PER WALLET, and the collection guide describes reusing a
// reference for retries of the same payment. Global uniqueness was therefore an
// assumption we never verified, and it has two failure modes:
//   * two different wallets legitimately using the same reference collide into
//     one identity, so one payment can block the other; and
//   * the key carries no wallet at all, so nothing downstream can prove WHICH
//     wallet a payment settled into.
//
// v2 makes the wallet part of the key: `moolre|collection|v2|<wallet>|<ref>`.
// The wallet segment is the TRUSTED server-side wallet (our configured
// collection account), never an unauthenticated provider payload assertion.
//
// V1 ROWS ARE NOT REWRITTEN. They remain blocking under their original key:
// a v1 claim cannot say which wallet it belonged to, so treating it as
// "not ours" would silently release a historical observation for a second
// economic use. Callers must check BOTH keys.
// =============================================================================

const WALLET_SCOPED_KEY_VERSION = 2;

/**
 * Normalize a TRUSTED wallet account (our configured collection account).
 * Deliberately numeric-only: Moolre collection accounts are numeric, and
 * accepting free text would let a caller smuggle a composite value into the
 * key. Returns null when the value cannot be a wallet.
 */
function normalizeWalletAccount(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
    if (typeof raw !== 'string') return null;
    const digits = raw.trim();
    if (!/^[0-9]{5,32}$/.test(digits)) return null;
    return digits;
}

/** The v1 key, kept solely so legacy rows can be found and honoured. */
function legacyObservationKey({ provider, reference } = {}) {
    const p = normalizeProvider(provider);
    const ref = normalizeReference(reference);
    if (!p || !ref) return null;
    return `${p}|collection|${ref}`;
}

/**
 * Canonical v2 identity: provider + trusted wallet + external reference.
 *
 * @throws ObservationIdentityError OBSERVATION_WALLET_MISSING when the wallet is
 *         absent or unusable. A missing wallet is NOT defaulted to the currently
 *         configured account: a historical payment may have settled into a
 *         different wallet, and guessing would be indistinguishable from fraud.
 */
function canonicalObservationIdentityV2({ provider, reference, accountNumber } = {}) {
    const p = normalizeProvider(provider);
    if (!p) {
        throw new ObservationIdentityError(
            'OBSERVATION_PROVIDER_UNSUPPORTED',
            '[wp-i] the provider on this observation is not a supported collection provider',
            { provider: provider ?? null },
        );
    }
    const ref = normalizeReference(reference);
    if (!ref) {
        throw new ObservationIdentityError(
            'OBSERVATION_REFERENCE_MISSING',
            '[wp-i] this provider observation carries no usable payment reference, so it cannot be claimed',
            { provider: p },
        );
    }
    // A v2 key is a delimited string, so the reference segment must not be able
    // to introduce its own separators. v1 tolerated any trimmed text; v2 refuses
    // anything outside a conservative reference charset rather than emit an
    // ambiguous key that classifies as a different observation.
    if (!/^[A-Za-z0-9._:-]+$/.test(ref)) {
        throw new ObservationIdentityError(
            'OBSERVATION_REFERENCE_UNSAFE',
            '[wp-i] this payment reference contains characters that cannot be used in a wallet-scoped key without ambiguity',
            { provider: p, reference: ref },
        );
    }
    const wallet = normalizeWalletAccount(accountNumber);
    if (!wallet) {
        throw new ObservationIdentityError(
            'OBSERVATION_WALLET_MISSING',
            '[wp-i] no trusted wallet account is established for this observation; a wallet-scoped identity cannot be built and the observation must not be claimed',
            { provider: p, reference: ref, walletAccount: accountNumber ?? null },
        );
    }
    return {
        observationKey: `${p}|collection|v${WALLET_SCOPED_KEY_VERSION}|${wallet}|${ref}`,
        legacyObservationKey: `${p}|collection|${ref}`,
        keyVersion: WALLET_SCOPED_KEY_VERSION,
        provider: p,
        reference: ref,
        walletAccount: wallet,
        accountKey: wallet,
    };
}

/**
 * Classify a stored key so callers can tell a legacy row from a wallet-scoped
 * one. Never guesses: an unrecognised shape returns version 0.
 */
function classifyObservationKey(key) {
    if (typeof key !== 'string') return { version: 0, walletAccount: null, reference: null };
    const v2 = /^([a-z]+)\|collection\|v2\|([0-9]{5,32})\|(.+)$/.exec(key);
    if (v2) return { version: 2, walletAccount: v2[2], reference: v2[3], provider: v2[1] };
    const v1 = /^([a-z]+)\|collection\|(.+)$/.exec(key);
    if (v1 && !v1[2].startsWith('v2|')) return { version: 1, walletAccount: null, reference: v1[2], provider: v1[1] };
    return { version: 0, walletAccount: null, reference: null };
}

module.exports = {
    QUARANTINE_PURPOSE,
    WALLET_SCOPED_KEY_VERSION,
    normalizeWalletAccount,
    legacyObservationKey,
    canonicalObservationIdentityV2,
    classifyObservationKey,
    CLAIM_PURPOSE,
    SUPPORTED_PROVIDERS,
    ObservationIdentityError,
    canonicalObservationIdentity,
    normalizeReference,
    normalizeProvider,
};
