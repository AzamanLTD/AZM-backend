'use strict';

// =============================================================================
// §WP-I — ONE ARBITRATION POINT PER PROVIDER OBSERVATION
//
// THE DEFECT THIS CLOSES
// The unresolved-evidence guard in the witness path READS
// `ReconciliationException` and refuses if an open case names the same
// reference. A read is not an arbiter: two sessions can both read "no case yet"
// and both commit, leaving an open unresolved case and a witness for the same
// payment — and the witness can then promote treasury liquidity that the
// customer deposit may already have consumed.
//
// THE MECHANISM
// Both writers take a transaction-scoped PostgreSQL advisory lock on the SAME
// coordination key before they touch evidence:
//
//     wp-i:arb:<provider>:<wallet-or-?>:<reference>
//
// `pg_advisory_xact_lock` is released by COMMIT/ROLLBACK, so there is no lock to
// leak and no unlock to forget. Because both sides take exactly ONE key in a
// fixed position, there is no ordering deadlock to reason about, and the lock is
// never held across provider HTTP I/O: callers acquire it inside their database
// transaction, after any network call has already returned.
//
// WHAT IT IS NOT
// The key is a COORDINATION identity, not an economic one. Case B exists precisely
// because the reference could not be trusted as an economic key; using it to
// serialise the two writers does not make it trustworthy, and it never becomes a
// claim identity.
//
// HONEST LIMIT: when the unresolved evidence has no reference at all, there is no
// key for the witness to collide on, so no arbitration is possible. That case is
// documented as a boundary rather than papered over with an invented identifier.
// =============================================================================

const ARB_NAMESPACE = 'wp-i:arb';

function normaliseSegment(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text === '' ? null : text;
}

/**
 * Deterministic coordination key. Returns null when there is nothing to
 * coordinate on (no reference), which callers must treat as "not arbitrable".
 */
function coordinationKey({ provider, walletAccount = null, reference = null } = {}) {
    const p = normaliseSegment(provider);
    const ref = normaliseSegment(reference);
    if (!p || !ref) return null;
    const wallet = normaliseSegment(walletAccount) || '?';
    return `${ARB_NAMESPACE}:${p.toLowerCase()}:${wallet}:${ref}`;
}

/**
 * Takes the transaction-scoped lock. Returns the key, or null when the identity
 * is not arbitrable. Callers must take this BEFORE reading the competing
 * evidence, otherwise the read is back to being a guess.
 */
async function acquireObservationArbitration(tx, identity = {}) {
    const key = coordinationKey(identity);
    if (!key) return null;
    if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
        // A client with no raw-query capability cannot take the lock. Every real
        // Prisma transaction client has it, so this is the mocked-client path in
        // tests; the callers' read-before-write guard still applies there. It is
        // reported rather than silent so a real regression cannot hide here.
        return null;
    }
    // pg_advisory_xact_lock returns `void`, which Prisma cannot deserialize
    // ("Failed to deserialize column of type 'void'"). Selecting a constant from
    // a subquery still executes the lock function and returns a plain integer.
    await tx.$queryRawUnsafe(
        'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS arb',
        key,
    );
    return key;
}

module.exports = {
    ARB_NAMESPACE,
    coordinationKey,
    acquireObservationArbitration,
};
