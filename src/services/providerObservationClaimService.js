'use strict';

// =============================================================================
// §WP-I — THE ATOMIC CROSS-PATH CLAIM
//
// THE DEFECT THIS CLOSES
// The treasury witness refused a payment that had "already settled a customer
// deposit" by READING the deposit path's records, and the deposit path refused a
// payment that had "already been witnessed" by reading the witness table. Two
// concurrent transactions can both read "not used yet" and both commit — one
// Moolre payment, two economic uses. A read is not a claim.
//
// THE MECHANISM
// Both paths INSERT a row for the same canonical observation key inside their
// OWN economic transaction. The unique index on `observationKey` is the only
// arbiter. The insert uses ON CONFLICT DO NOTHING, so a loser does not poison
// its transaction with an aborted-transaction state — it learns it lost and
// aborts deliberately, taking every economic effect of that transaction with it.
//
// IDEMPOTENCY IS NOT INFERRED FROM THE KEY
// A same-path retry is allowed to continue ONLY when the existing claim names
// the same owner (`claimedByRef`) — the caller still has to prove its own
// economic operation state. A `claimed:false` result is never a success, and a
// different purpose is always a typed refusal.
// =============================================================================

const crypto = require('crypto');
const {
    CLAIM_PURPOSE,
    QUARANTINE_PURPOSE,
    ObservationIdentityError,
    canonicalObservationIdentityV2,
    legacyObservationKey,
} = require('./providerObservationIdentity');

class ProviderObservationClaimError extends Error {
    constructor(code, message, detail = {}) {
        super(message);
        this.name = 'ProviderObservationClaimError';
        this.code = code;
        this.detail = detail;
        this.conflict = true;
    }
}

const TABLE = 'ProviderObservationClaim';

/**
 * Try to take the single economic-use claim for one provider observation.
 *
 * MUST be called with the caller's transaction client (`tx`), inside the same
 * transaction as the economic effects it protects.
 *
 * @returns {Promise<{claimed: boolean, observationKey: string, purpose: string,
 *                    claimedByRef: string|null, samePathRetry: boolean}>}
 * @throws  ProviderObservationClaimError  when a DIFFERENT economic use holds it
 */
async function claimProviderObservation(tx, {
    provider,
    reference,
    accountNumber = null,
    purpose,
    claimedByRef = null,
}) {
    if (!Object.values(CLAIM_PURPOSE).includes(purpose)) {
        throw new ProviderObservationClaimError(
            'OBSERVATION_CLAIM_PURPOSE_INVALID',
            `[wp-i] unknown economic-use purpose ${purpose}`,
        );
    }
    if (!tx || typeof tx.$executeRaw !== 'function') {
        throw new ProviderObservationClaimError(
            'OBSERVATION_CLAIM_UNVERIFIABLE',
            '[wp-i] this client cannot enforce the provider-observation claim, so the economic operation cannot proceed',
        );
    }

    // ── §WP-I CUT-OVER: THE WALLET-SCOPED IDENTITY IS THE ONLY WRITER KEY ────
    // Every writer now files the wallet-scoped v2 identity. A claim without a
    // trusted wallet is REFUSED rather than written under the legacy key: writing
    // v1 here while any other path writes v2 is the double-spend window, because
    // the two keys do not collide and one payment could be claimed under each.
    let identity;
    try {
        identity = canonicalObservationIdentityV2({ provider, reference, accountNumber });
    } catch (e) {
        if (e instanceof ObservationIdentityError) {
            throw new ProviderObservationClaimError(e.code, e.message, e.detail);
        }
        throw e;
    }

    // A FROZEN legacy claim still owns this payment. v1 rows are never rewritten
    // (their wallet is unknown), and no v2 claim may step over one: nothing writes
    // v1 any more, so this read cannot race a concurrent v1 writer.
    const legacyKey = legacyObservationKey({ provider, reference });
    if (legacyKey) {
        const legacyRows = await tx.$queryRawUnsafe(
            `SELECT "purpose", "claimedByRef" FROM "ProviderObservationClaim" WHERE "observationKey" = $1 LIMIT 1`,
            legacyKey,
        );
        const legacy = Array.isArray(legacyRows) ? legacyRows[0] : null;
        if (legacy && !(legacy.purpose === purpose && legacy.claimedByRef === claimedByRef)) {
            throw new ProviderObservationClaimError(
                'OBSERVATION_CLAIM_LEGACY_CONFLICT',
                '[wp-i] this provider observation is already claimed under the legacy identity by a different economic use; '
                + 'the wallet-scoped claim cannot step over it',
                { legacyObservationKey: legacyKey, heldBy: legacy.purpose, claimedByRef: legacy.claimedByRef },
            );
        }
    }

    const id = crypto.randomUUID();
    // ON CONFLICT DO NOTHING keeps the transaction usable: a plain unique
    // violation would abort it and every later statement would fail with
    // 25P02, which is exactly the trap a "catch and continue" design falls into.
    const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO "${TABLE}" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6, now(), now())
         ON CONFLICT ("observationKey") DO NOTHING`,
        id, identity.observationKey, purpose, claimedByRef, identity.provider, identity.accountKey,
    );

    if (inserted === 1) {
        return {
            claimed: true,
            observationKey: identity.observationKey,
            purpose,
            claimedByRef,
            samePathRetry: false,
        };
    }

    const existing = await tx.providerObservationClaim.findUnique({
        where: { observationKey: identity.observationKey },
    });
    if (!existing) {
        // A row blocked the insert but is not visible: only possible under a
        // racing uncommitted insert. Treat as a conflict, never as a claim.
        throw new ProviderObservationClaimError(
            'OBSERVATION_CLAIM_RACING',
            '[wp-i] another transaction is claiming this provider observation right now',
            { observationKey: identity.observationKey },
        );
    }

    if (existing.purpose === QUARANTINE_PURPOSE) {
        // Historical cross-path collision, quarantined during the backfill.
        // Neither path is declared the owner, and neither may consume it: the
        // only way past this is an operator resolving the history by hand.
        throw new ProviderObservationClaimError(
            'OBSERVATION_QUARANTINED',
            '[wp-i] this provider observation was used economically by BOTH paths in historical records and is quarantined for operator review; neither path may consume it',
            { observationKey: existing.observationKey, heldBy: existing.purpose, claimedByRef: existing.claimedByRef },
        );
    }

    if (existing.purpose !== purpose) {
        throw new ProviderObservationClaimError(
            'OBSERVATION_SPENT_BY_OTHER_PATH',
            existing.purpose === CLAIM_PURPOSE.TREASURY_WITNESS
                ? '[wp-i] this provider payment already funded a treasury opening; one payment cannot also settle a customer deposit'
                : '[wp-i] this provider payment already settled a customer deposit; one payment cannot also fund a treasury opening',
            {
                observationKey: existing.observationKey,
                heldBy: existing.purpose,
                claimedByRef: existing.claimedByRef,
            },
        );
    }

    if (existing.claimedByRef && claimedByRef && existing.claimedByRef !== claimedByRef) {
        throw new ProviderObservationClaimError(
            'OBSERVATION_SPENT_BY_SAME_PATH_OTHER_OWNER',
            `[wp-i] this provider payment is already claimed by another ${existing.purpose} operation`,
            {
                observationKey: existing.observationKey,
                heldBy: existing.purpose,
                claimedByRef: existing.claimedByRef,
            },
        );
    }

    if (existing.accountKey && identity.accountKey && existing.accountKey !== identity.accountKey) {
        throw new ProviderObservationClaimError(
            'OBSERVATION_ACCOUNT_MISMATCH',
            '[wp-i] the same provider reference was observed against a different account; refusing to merge them, operator review required',
            {
                observationKey: existing.observationKey,
                claimedAccount: existing.accountKey,
                observedAccount: identity.accountKey,
            },
        );
    }

    // Same purpose, same owner: a retry of the SAME operation. The caller must
    // still verify its own operation state before treating this as settled.
    return {
        claimed: false,
        observationKey: existing.observationKey,
        purpose,
        claimedByRef: existing.claimedByRef ?? null,
        samePathRetry: true,
    };
}

module.exports = {
    CLAIM_PURPOSE,
    ProviderObservationClaimError,
    claimProviderObservation,
};
