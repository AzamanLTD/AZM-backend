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
//   - resolving that ownership back for reconciliation, INCLUDING recovery
//     from durable dispatch evidence when the canonical ownership write
//     failed after the provider had already accepted the payout
//
// Ownership invariant (r15 follow-up, audit P0 2026-09-20; hardening pass
// same day — "bookkeeping-failure paths surrounding already-accepted money"):
//   once a dispatch returns successfully, reconciliation can determine
//     WHICH provider owns the payout without guessing or polling another
//     rail first. If ownership CANNOT be durably established, the payout
//     must remain unresolved and protected — reconciliation must NEVER fall
//     back to cross-provider guessing merely because the ownership
//     bookkeeping write failed.
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
// Conflict semantics (first-writer-wins):
//   - the FIRST durably established owner is authoritative
//   - a second writer naming the SAME provider is idempotent
//   - a second writer naming a DIFFERENT provider FAILS CLOSED: the first
//     owner survives untouched, a durable conflict record is appended to
//     metadata.payoutProviderConflicts, and an OwnershipConflictError is
//     thrown for the caller to escalate. Ownership is never
//     last-writer-wins — two different providers can never both be the
//     honest owner of the same reference.
//
// Legacy rows (created before this field exists) carry no payoutProvider:
// reconciliation falls back to durable dispatch evidence, and only then to
// the no-hint cross-provider status search, which remains correct for
// genuinely-unknown ownership.
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

// The canonical identities a durable dispatch observation can carry. Only
// these are admissible owner evidence.
const KNOWN_CANONICAL_PROVIDERS = Object.freeze(Object.values(TAG_TO_CANONICAL));

// Error taxonomy — callers (controller / payout worker / recon worker)
// branch on `code` to escalate without string matching.
class OwnershipError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'OwnershipError';
        this.code = code;
        this.details = details;
    }
}
class OwnershipPersistenceError extends OwnershipError {
    constructor(message, details = {}) {
        super('OWNERSHIP_PERSIST_FAILED', message, details);
        this.name = 'OwnershipPersistenceError';
    }
}
class OwnershipConflictError extends OwnershipError {
    constructor(message, details = {}) {
        super('OWNERSHIP_CONFLICT', message, details);
        this.name = 'OwnershipConflictError';
    }
}

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
 * durably recorded (legacy rows — reconciliation must resolve ownership
 * from durable evidence, then fall back to the no-hint cross-provider
 * status search).
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
 * DURABLE, CONFLICT-SAFE write of ACTUAL provider ownership into the
 * canonical TransactionHistory row. FIRST-WRITER-WINS:
 *
 *   - unowned non-terminal row        → owner recorded (single statement)
 *   - same-owner replay               → idempotent success (terminal or not)
 *   - DIFFERENT owner already present → OwnershipConflictError; the first
 *                                        owner is never overwritten and a
 *                                        durable conflict record is appended
 *   - canonical row missing           → OwnershipPersistenceError (fail
 *                                        closed: an accepted dispatch must
 *                                        never be left looking unowned)
 *   - terminal row with NO owner       → OwnershipPersistenceError (the
 *                                        payout resolved without ownership
 *                                        knowledge — loud, never a warn)
 *
 * Only non-terminal rows (PENDING, FROZEN_DISPUTE) can newly acquire an
 * owner: once the payout is terminal the actual provider is settled
 * history and must not be rewritten.
 *
 * The guarded WHERE makes the write itself atomic against concurrent
 * writers: the ownership patch only lands when the row is unowned or
 * already owned by the SAME provider.
 */
async function persistPayoutOwnership(prisma, { reference, failoverTag, intendedProvider = null, providerRef = null }) {
    if (!reference) throw new Error('[payoutProviderOwnership] reference is required.');
    if (!failoverTag) throw new Error('[payoutProviderOwnership] failoverTag is required.');

    const canonicalName = canonicalProviderName(failoverTag);
    if (!canonicalName) {
        throw new OwnershipPersistenceError(
            `[payoutProviderOwnership] unknown failover tag: ${failoverTag}`,
            { reference, failoverTag }
        );
    }

    const tag = String(failoverTag);
    const patch = {
        payoutProvider: tag,
        payoutProviderName: canonicalName,
        ownershipRecordedAt: new Date().toISOString(),
    };
    if (intendedProvider) patch.intendedProvider = String(intendedProvider);
    if (providerRef != null) patch.ownershipProviderRef = String(providerRef);

    const updated = await prisma.$executeRawUnsafe(
        'UPDATE "TransactionHistory" ' +
        'SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || $1::jsonb ' +
        'WHERE "txHash" = $2 AND "status" IN (\'PENDING\', \'FROZEN_DISPUTE\') ' +
        'AND (COALESCE("metadata", \'{}\'::jsonb)->>\'payoutProvider\' IS NULL ' +
        '     OR COALESCE("metadata", \'{}\'::jsonb)->>\'payoutProvider\' = $3)',
        JSON.stringify(patch),
        String(reference),
        tag
    );

    if (updated === 1) {
        return { rowsUpdated: 1, owner: { tag, canonicalName } };
    }

    // Zero rows: the guarded write did not land. Distinguish the cases —
    // on an ACCEPTED dispatch none of them is a harmless warn.
    const rows = await prisma.$queryRawUnsafe(
        'SELECT "id", "status", COALESCE("metadata", \'{}\'::jsonb)->>\'payoutProvider\' AS "owner" ' +
        'FROM "TransactionHistory" WHERE "txHash" = $1',
        String(reference)
    );
    if (!rows || rows.length === 0) {
        throw new OwnershipPersistenceError(
            '[payoutProviderOwnership] no canonical TransactionHistory row carries this reference — ownership NOT established for an accepted dispatch',
            { reference, failoverTag: tag }
        );
    }
    const row = rows[0];
    const existingOwner = row.owner || null;

    if (existingOwner === tag) {
        // Same-owner replay (e.g. settlement raced the bookkeeping and the
        // row is already terminal): the owner IS durably recorded — success.
        return { rowsUpdated: 0, idempotent: true, owner: { tag, canonicalName } };
    }

    if (existingOwner && existingOwner !== tag) {
        // A DIFFERENT provider is already the durable owner. Never
        // overwrite: append a durable conflict record and fail closed.
        const conflict = {
            requestedTag: tag,
            requestedProvider: canonicalName,
            recordedOwner: existingOwner,
            providerRef: providerRef != null ? String(providerRef) : null,
            at: new Date().toISOString(),
        };
        await prisma.$executeRawUnsafe(
            'UPDATE "TransactionHistory" ' +
            'SET "metadata" = jsonb_set(COALESCE("metadata", \'{}\'::jsonb), \'{payoutProviderConflicts}\', ' +
            '  COALESCE(COALESCE("metadata", \'{}\'::jsonb)->\'payoutProviderConflicts\', \'[]\'::jsonb) || $1::jsonb, true) ' +
            'WHERE "txHash" = $2',
            JSON.stringify([conflict]),
            String(reference)
        );
        logger.error({ reference, requestedTag: tag, recordedOwner: existingOwner },
            '[payoutProviderOwnership] OWNERSHIP CONFLICT: a different provider is already the durable owner');
        throw new OwnershipConflictError(
            `[payoutProviderOwnership] payout ${reference} is already owned by '${existingOwner}' — refusing to overwrite with '${tag}'`,
            { reference, requestedTag: tag, recordedOwner: existingOwner }
        );
    }

    // No owner + terminal row: the payout resolved without ownership ever
    // being established. Fail closed — never a silent warn.
    throw new OwnershipPersistenceError(
        `[payoutProviderOwnership] canonical row for ${reference} is terminal (${row.status}) without recorded ownership — ownership NOT established`,
        { reference, status: row.status }
    );
}

/**
 * Resolve the durable owner of a payout for reconciliation, using ALL
 * authoritative durable evidence, most-authoritative first:
 *
 *   1. canonical TransactionHistory metadata (payoutProvider)
 *   2. unique durable dispatch-acceptance evidence (FiatProviderEvent
 *      dispatch observation naming the actual provider) — the recovery
 *      path for an accepted dispatch whose canonical ownership write
 *      failed AFTER the provider already had the money
 *
 * Returns a resolution object:
 *   { status: 'OWNED',     owner: { tag, canonicalName } }
 *   { status: 'RECOVERED', owner: { tag, canonicalName } }   — from evidence
 *   { status: 'CONFLICT',  owners: [{ tag, canonicalName }, ...] } — two
 *      different providers hold durable owner evidence for one reference:
 *      NEVER guess; the caller parks for operator review
 *   { status: 'UNKNOWN' }  — no owner evidence at all; the caller may use
 *      the legacy no-hint cross-provider search (unless dispatch
 *      bookkeeping itself failed durably — the caller checks the
 *      reconciliation exception queue for that)
 */
async function resolvePayoutOwner(prisma, transactionHistoryRow) {
    const reference = transactionHistoryRow?.txHash;
    if (!reference) return { status: 'UNKNOWN' };

    // 1. Canonical ownership metadata — authoritative when present.
    const persisted = readPayoutOwner(transactionHistoryRow);
    if (persisted) {
        return { status: 'OWNED', owner: persisted };
    }

    // 2. Durable dispatch-acceptance evidence. The dispatch observation
    //    (dedupKey 'event:payout-dispatch:<provider>:<reference>') is
    //    written BEFORE the canonical ownership write at dispatch time, so
    //    it survives an ownership-bookkeeping failure. Only KNOWN provider
    //    identities are admissible; anything else is not owner evidence.
    const events = await prisma.fiatProviderEvent.findMany({
        where: {
            relatedReference: String(reference),
            direction: 'OUTBOUND',
            dedupKey: { startsWith: 'event:payout-dispatch:' },
            provider: { in: [...KNOWN_CANONICAL_PROVIDERS] },
        },
        select: { provider: true, dedupKey: true },
        orderBy: { receivedAt: 'asc' },
    });

    const distinctProviders = [...new Set(events.map(e => e.provider))];
    if (distinctProviders.length === 1) {
        const canonicalName = distinctProviders[0];
        const tag = failoverTagFromCanonical(canonicalName);
        if (tag) {
            return { status: 'RECOVERED', owner: { tag, canonicalName } };
        }
        // Known canonical name that does not map to a failover tag cannot
        // happen while both maps are generated from the same registry —
        // but treat it as unresolved rather than guessing.
        return { status: 'CONFLICT', owners: [{ tag: null, canonicalName }] };
    }
    if (distinctProviders.length > 1) {
        // Two different providers hold dispatch evidence for the SAME
        // reference. This is a double-dispatch defect or a rail identity
        // bug — NEVER pick one; park for operator review.
        return {
            status: 'CONFLICT',
            owners: distinctProviders.map(canonicalName => ({
                tag: failoverTagFromCanonical(canonicalName),
                canonicalName,
            })),
        };
    }

    // 3. No owner evidence at all.
    return { status: 'UNKNOWN' };
}

module.exports = {
    TAG_TO_CANONICAL,
    CANONICAL_TO_TAG,
    KNOWN_CANONICAL_PROVIDERS,
    canonicalProviderName,
    failoverTagFromCanonical,
    readPayoutOwner,
    persistPayoutOwnership,
    resolvePayoutOwner,
    OwnershipPersistenceError,
    OwnershipConflictError,
};
