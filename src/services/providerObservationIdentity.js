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

module.exports = {
    CLAIM_PURPOSE,
    SUPPORTED_PROVIDERS,
    ObservationIdentityError,
    canonicalObservationIdentity,
    normalizeReference,
    normalizeProvider,
};
