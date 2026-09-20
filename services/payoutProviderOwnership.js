// services/payoutProviderOwnership.js
// =============================================================================
// AZAMAN — PAYOUT PROVIDER OWNERSHIP (canonical actual-provider authority)
//
// Production disbursement runs through PaymentFailoverService
// (moolre -> mtn, priority order). initiateTransfer() tags the ACCEPTING
// provider on its result ({ _provider: 'moolre' | 'mtn' }), but ownership
// must be DURABLE: reconciliation may run minutes/hours later, on another
// instance, after a crash. This module is the single authority for:
//
//   - the failover-tag / canonical-provider-identity mapping
//   - persisting the ACTUAL provider that accepted a dispatch into the
//     canonical TransactionHistory row (metadata.payoutProvider) - distinct
//     from the INTENDED route recorded at reservation time
//   - reading that ownership back for reconciliation
//
// Ownership invariant (r15 follow-up, audit P0 2026-09-20):
//   once a dispatch returns successfully, reconciliation can determine
//   WHICH provider owns the payout without guessing or polling another
//   rail first.
//
// The two identities are deliberately BOTH recorded:
//   metadata.intendedProvider    - the requested/primary route at
//                                  reservation time (historical intent
//                                  semantics preserved for audit)
//   metadata.payoutProvider      - the failover tag of the provider that
//                                  actually ACCEPTED the dispatch
//                                  ('moolre' | 'mtn')
//   metadata.payoutProviderName  - the canonical adapter identity
//                                  ('MOOLRE_DISBURSEMENT' |
//                                   'MTN_MOMO_DISBURSEMENT') for evidence
//                                  and settlement-attempt bookkeeping
//                                  without a status poll
//
// Legacy rows (created before this field exists) carry no payoutProvider:
// reconciliation falls back to the no-hint cross-provider status search,
// which remains correct for genuinely-unknown ownership.
// =============================================================================

const logger = require('../src/config/logger');

// Failover tag -> the canonical provider identity reported by that
// provider's adapter on transfer-status responses (PROVIDER_NAME).
const TAG_TO_CANONICAL = Object.freeze({
    moolre: 'MOOLRE_DISBURSEMENT',
    mtn:    'MTN_MOMO_DISBURSEMENT',
});

// Canonical identity (and legacy aliases) -> failover tag. Used when a
// provider status answer identifies itself but the stored owner field is
// absent, and for seeding/tests.
const CANONICAL_TO_TAG = Object.freeze({
    MOOLRE:                 'moolre',
    MOOLRE_DISBURSEMENT:    'moolre',
    MTN_MOMO:               'mtn',
    MTN_MOMO_DISBURSEMENT:  'mtn',
});

/**
 * Canonical provider identity for a failover tag (null for unknown tags).
 */
function canonicalProviderName(failoverTag) {
    return TAG_TO_CANONICAL[String(failoverTag || '').toLowerCase()] || null;
}

/**
 * Failover tag for a canonical (or legacy-aliased) provider identity
 * (null for unknown names).
 */
function failoverTagFromCanonical(canonicalName) {
    return CANONICAL_TO_TAG[String(canonicalName || '').toUpperCase()] || null;
}

/**
 * Read the persisted ACTUAL payout owner off a canonical TransactionHistory
 * row. Returns { tag, canonicalName } or null when ownership is not
 * durably recorded (legacy rows - reconciliation must use the no-hint
 * cross-provider status search).
 */
function readPayoutOwner(transactionHistoryRow) {
    const metadata = transactionHistoryRow?.metadata;
    if (!metadata || typeof metadata !== 'object') return null;
    const tag = metadata.payoutProvider;
    if (!tag) return null;
    const canonicalName = canonicalProviderName(tag);
    if (!canonicalName) {
        // A recorded owner we cannot map is still a recorded owner: never
        // silently fall back to cross-provider polling for this payout.
        return { tag: String(tag), canonicalName: null, unmapped: true };
    }
    return { tag, canonicalName };
}

/**
 * Durable, idempotent write of ACTUAL provider ownership into the canonical
 * TransactionHistory row. Single SQL statement: the jsonb merge is atomic
 * at the statement level, so concurrent writers converge (last merge wins
 * on the ownership keys, and - because a reference names exactly one
 * dispatch - the values are identical in practice).
 *
 * Only non-terminal rows (PENDING, FROZEN_DISPUTE) are updated: once the payout is terminal
 * the actual provider is already settled history and must not be rewritten.
 *
 * The update is one statement with a guarded WHERE, so it is idempotent:
 * replays re-merge the same ownership patch and never duplicate financial
 * rows.
 */
async function persistPayoutOwnership(prisma, { reference, failoverTag, intendedProvider = null, providerRef = null }) {
    if (!reference) throw new Error('[payoutProviderOwnership] reference is required.');
    if (!failoverTag) throw new Error('[payoutProviderOwnership] failoverTag is required.');

    const canonicalName = canonicalProviderName(failoverTag);
    if (!canonicalName) {
        throw new Error(`[payoutProviderOwnership] unknown failover tag: ${failoverTag}`);
    }

    const patch = {
        payoutProvider: String(failoverTag),
        payoutProviderName: canonicalName,
        ownershipRecordedAt: new Date().toISOString(),
    };
    if (intendedProvider) patch.intendedProvider = String(intendedProvider);
    if (providerRef != null) patch.ownershipProviderRef = String(providerRef);

    const result = await prisma.$executeRawUnsafe(
        'UPDATE "TransactionHistory" ' +
        'SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || $1::jsonb ' +
        'WHERE "txHash" = $2 AND "status" IN (\'PENDING\', \'FROZEN_DISPUTE\')',
        JSON.stringify(patch),
        String(reference)
    );

    if (result === 0) {
        logger.warn({ reference, failoverTag },
            '[payoutProviderOwnership] no non-terminal canonical row carries this reference - ownership not persisted');
    }
    return { rowsUpdated: result };
}

module.exports = {
    TAG_TO_CANONICAL,
    CANONICAL_TO_TAG,
    canonicalProviderName,
    failoverTagFromCanonical,
    readPayoutOwner,
    persistPayoutOwnership,
};
