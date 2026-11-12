// src/services/authorityState.js
// =============================================================================
// §WP-H — THE TRI-STATE AUTHORITY BOUNDARY.
//
// WHAT WAS WRONG WITH THE OLD LATCH
// `isAuthorityModeActive()` answered a Boolean built from two writable places:
// GlobalSettings.fiatLiquidityAuthorityEnabled and the nullable
// FiatLiquidityState.authorityActivatedAt column, which the runtime role owns
// and can UPDATE. A Boolean cannot express "I could not prove the invariant",
// so every failure had to be squeezed into `false` — and `false` means "legacy
// USDC" to every caller. A failed inspection therefore relabelled GHS-backed
// liabilities as USDC. That is the defect this module exists to remove.
//
// THREE STATES, ONE MEANING EACH
//   ENFORCED_INACTIVE — the protected table exists, ownership and privileges are
//                       as designed, the immutability triggers are enabled, and
//                       there is NO activation record. Unit: USDC.
//   ENFORCED_ACTIVE   — the same positive verification, plus one valid,
//                       immutable activation record. Unit: GHS.
//   UNKNOWN           — anything else. There is NO unit. No caller may infer
//                       one; the only legal reaction is to refuse with a typed
//                       AUTHORITY_STATE_UNAVAILABLE failure.
//
// POSITIVE VERIFICATION ONLY
// The inactive state is proved, not assumed: it requires the same inspection
// evidence as the active state. A missing table, an unsafe owner, a runtime
// role with write rights, a disabled trigger or a failed probe are all UNKNOWN,
// never "inactive".
//
// LEGACY CONTRADICTION
// If the mutable legacy latch says "activated" while the protected table holds
// no record, the two cannot be reconciled: the database was activated under a
// regime the protected record never saw. That is UNKNOWN, not inactive.
//
// LOCKING (see docs/wp-h/tristate-authority.md)
// Every economic path takes the SHARED transaction-scoped advisory lock BEFORE
// reading the state and holds it through its commit. Activation takes the
// EXCLUSIVE lock on the SAME key before inserting and holds it through commit.
// The lock — not a row lock — covers the no-record case, where there is no row
// to lock. Same key everywhere: AUTHORITY_LOCK_KEY.
// =============================================================================
'use strict';

const {
    inspectEnforcement,
    readActivationRecord,
    PROBLEM,
} = require('./authorityActivationEnforcement');

// ONE identity for the regime lock. Deliberately identical to the key the
// activation sequence already uses (fiatLiquidityActivationService
// ACTIVATION_LOCK_KEY); __tests__/wp-h-tristate-authority.pg.test.js asserts the
// two constants stay equal so they cannot drift into two unrelated keys.
const AUTHORITY_LOCK_KEY = 'azm.p5d.authority.activation';

const AUTHORITY_STATE = Object.freeze({
    ENFORCED_INACTIVE: 'ENFORCED_INACTIVE',
    ENFORCED_ACTIVE: 'ENFORCED_ACTIVE',
    UNKNOWN: 'UNKNOWN',
});

const AUTHORITY_UNIT = Object.freeze({ GHS: 'GHS', USDC: 'USDC' });

const UNKNOWN_REASON = Object.freeze({
    INSPECTION_FAILED: 'INSPECTION_FAILED',
    ENFORCEMENT_NOT_ESTABLISHED: 'ENFORCEMENT_NOT_ESTABLISHED',
    TABLE_MISSING: 'TABLE_MISSING',
    ACTIVATION_UNREADABLE: 'ACTIVATION_UNREADABLE',
    ACTIVATION_MALFORMED: 'ACTIVATION_MALFORMED',
    LEGACY_CONTRADICTS_INACTIVE: 'LEGACY_CONTRADICTS_INACTIVE',
    LEGACY_UNREADABLE: 'LEGACY_UNREADABLE',
});

const DIGEST = /^[0-9a-f]{64}$/i;

/**
 * The typed refusal. Carries no role, table or privilege detail in its message
 * (safe to surface), and the operator detail on `.problems` for server logs.
 * There is intentionally NO `unit`, `active`, `balance` or `rate` property: a
 * caller cannot accidentally read a currency out of a refusal.
 */
class AuthorityStateUnavailable extends Error {
    constructor({ reason, problems = [], diagnostics = null, cause = null } = {}) {
        super('[WP-H] the fiat authority state could not be positively established, so the '
            + 'unit of account is unknown. Refusing rather than assuming legacy USDC or GHS.');
        this.name = 'AuthorityStateUnavailable';
        this.code = 'AUTHORITY_STATE_UNAVAILABLE';
        this.statusCode = 503;
        this.state = AUTHORITY_STATE.UNKNOWN;
        this.reason = reason || UNKNOWN_REASON.ENFORCEMENT_NOT_ESTABLISHED;
        this.problems = Array.isArray(problems) ? problems : [];
        this.diagnostics = diagnostics || null;
        this.cause = cause || null;
    }
}

const _blank = (v) => typeof v !== 'string' || v.trim() === '';

/**
 * Validate the protected record. An enforceable-looking table holding a
 * malformed row is UNKNOWN: the row is a control decision, and a control
 * decision that cannot be read exactly is not a decision.
 */
function validateActivation(record) {
    const problems = [];
    if (!record) return { valid: false, problems: ['ACTIVATION_MISSING'] };
    if (record.id !== 1) problems.push('ACTIVATION_ID_NOT_SINGLETON');
    if (!(record.activatedAt instanceof Date) || Number.isNaN(record.activatedAt.getTime())) {
        problems.push('ACTIVATION_AT_NOT_A_TIMESTAMP');
    }
    if (_blank(record.activatedBy)) problems.push('ACTIVATION_BY_BLANK');
    if (_blank(record.approvedBy)) problems.push('APPROVED_BY_BLANK');
    if (_blank(record.evidenceReference)) problems.push('EVIDENCE_REFERENCE_BLANK');
    if (_blank(record.evidenceDigest) || !DIGEST.test(String(record.evidenceDigest || ''))) {
        problems.push('EVIDENCE_DIGEST_NOT_A_SHA256');
    }
    return { valid: problems.length === 0, problems };
}

/**
 * Read the mutable legacy latch, used ONLY to detect a contradiction with the
 * protected record. It is never a source of the state itself.
 */
async function readLegacyLatch(db) {
    try {
        const rows = await db.$queryRawUnsafe(`
            SELECT COALESCE(g."fiatLiquidityAuthorityEnabled", false) AS "flagged",
                   s."authorityActivatedAt" AS "activatedAt"
              FROM (SELECT 1 AS "id") AS anchor
              LEFT JOIN "GlobalSettings" g ON g."id" = 1
              LEFT JOIN "FiatLiquidityState" s ON s."id" = 1`);
        const row = (rows && rows[0]) || {};
        return { readable: true, flagged: row.flagged === true, activatedAt: row.activatedAt || null };
    } catch (_) {
        return { readable: false, flagged: false, activatedAt: null };
    }
}

/**
 * THE authority read. Read-only, safe for a runtime role, and never throws for
 * an unprovable state — it returns UNKNOWN with the reason and problems.
 *
 * @returns {Promise<{state:string, unit:string|null, active:boolean|null,
 *                    reason:string|null, activation:object|null,
 *                    problems:string[], diagnostics:object|null,
 *                    legacy:object|null}>}
 */
async function resolveAuthorityState(db) {
    const unknown = (reason, extra = {}) => ({
        state: AUTHORITY_STATE.UNKNOWN,
        unit: null,
        active: null,
        reason,
        activation: null,
        problems: extra.problems || [],
        diagnostics: extra.diagnostics || null,
        legacy: extra.legacy || null,
    });

    let inspection;
    try {
        inspection = await inspectEnforcement(db);
    } catch (err) {
        return unknown(UNKNOWN_REASON.INSPECTION_FAILED, {
            problems: [PROBLEM.ENFORCEMENT_PROBE_FAILED],
            diagnostics: { error: err && err.message ? err.message : String(err) },
        });
    }

    const problems = (inspection && inspection.problems) || [];
    const diagnostics = (inspection && inspection.diagnostics) || null;
    if (problems.includes(PROBLEM.TABLE_MISSING)) {
        return unknown(UNKNOWN_REASON.TABLE_MISSING, { problems, diagnostics });
    }
    if (!inspection || inspection.established !== true || problems.length > 0) {
        return unknown(UNKNOWN_REASON.ENFORCEMENT_NOT_ESTABLISHED, { problems, diagnostics });
    }

    let activation;
    try {
        activation = await readActivationRecord(db);
    } catch (_) {
        return unknown(UNKNOWN_REASON.ACTIVATION_UNREADABLE, { problems, diagnostics });
    }

    const legacy = await readLegacyLatch(db);

    if (!activation) {
        // No record. Inactive ONLY if the legacy latch agrees there was never an
        // activation; otherwise the two disagree and nothing can be inferred.
        if (!legacy.readable) {
            return unknown(UNKNOWN_REASON.LEGACY_UNREADABLE, { problems, diagnostics, legacy });
        }
        if (legacy.flagged === true || legacy.activatedAt != null) {
            return unknown(UNKNOWN_REASON.LEGACY_CONTRADICTS_INACTIVE, {
                problems: ['LEGACY_LATCH_SET_WITHOUT_PROTECTED_RECORD'],
                diagnostics,
                legacy,
            });
        }
        return {
            state: AUTHORITY_STATE.ENFORCED_INACTIVE,
            unit: AUTHORITY_UNIT.USDC,
            active: false,
            reason: null,
            activation: null,
            problems: [],
            diagnostics,
            legacy,
        };
    }

    const check = validateActivation(activation);
    if (!check.valid) {
        return unknown(UNKNOWN_REASON.ACTIVATION_MALFORMED, {
            problems: check.problems,
            diagnostics,
            legacy,
        });
    }

    return {
        state: AUTHORITY_STATE.ENFORCED_ACTIVE,
        unit: AUTHORITY_UNIT.GHS,
        active: true,
        reason: null,
        activation,
        problems: [],
        diagnostics,
        legacy,
    };
}

/** The economic gate: resolve, then refuse loudly when the state is UNKNOWN. */
async function requireAuthorityState(db) {
    const resolved = await resolveAuthorityState(db);
    if (resolved.state === AUTHORITY_STATE.UNKNOWN) {
        throw new AuthorityStateUnavailable({
            reason: resolved.reason,
            problems: resolved.problems,
            diagnostics: resolved.diagnostics,
        });
    }
    return resolved;
}

// ── Advisory-lock protocol ───────────────────────────────────────────────────
// Transaction-scoped, so PostgreSQL releases them on COMMIT/ROLLBACK and no
// caller can leak one. SHARED for economic reads+writes, EXCLUSIVE for
// activation, one key.

async function lockAuthorityShared(tx) {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock_shared(hashtext($1))', AUTHORITY_LOCK_KEY);
}

async function lockAuthorityExclusive(tx) {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', AUTHORITY_LOCK_KEY);
}

/** Non-blocking probes, for tests and for bounded retry paths. */
async function tryLockAuthorityShared(tx) {
    const rows = await tx.$queryRawUnsafe('SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS ok', AUTHORITY_LOCK_KEY);
    return rows[0].ok === true;
}

async function tryLockAuthorityExclusive(tx) {
    const rows = await tx.$queryRawUnsafe('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', AUTHORITY_LOCK_KEY);
    return rows[0].ok === true;
}

/**
 * The economic wrapper: the lock first, then the state read, both inside the
 * caller's transaction, so the state cannot change between the decision and the
 * commit that depends on it.
 */
async function withAuthoritySnapshot(tx, fn) {
    await lockAuthorityShared(tx);
    const resolved = await requireAuthorityState(tx);
    return fn(resolved);
}

/** True when the deployment has opted into the tri-state regime. */
function enforcementMode() {
    return process.env.AUTHORITY_ENFORCEMENT_MODE === 'tri_state' ? 'tri_state' : 'legacy';
}

module.exports = {
    AUTHORITY_STATE,
    AUTHORITY_UNIT,
    AUTHORITY_LOCK_KEY,
    UNKNOWN_REASON,
    AuthorityStateUnavailable,
    validateActivation,
    readLegacyLatch,
    resolveAuthorityState,
    requireAuthorityState,
    lockAuthorityShared,
    lockAuthorityExclusive,
    tryLockAuthorityShared,
    tryLockAuthorityExclusive,
    withAuthoritySnapshot,
    enforcementMode,
};
