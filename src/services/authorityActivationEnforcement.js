// src/services/authorityActivationEnforcement.js
// =============================================================================
// §WP-E — THE DATABASE-ENFORCED AUTHORITY GATE.
//
// THE PROBLEM THIS SOLVES
// `FiatLiquidityState.authorityActivatedAt` lives on a table the application
// runtime role owns. A one-way latch that the reading role can UPDATE to NULL,
// DELETE, or TRUNCATE is a code convention, not a boundary — and the earlier
// review demonstrated exactly that: the table owner and the application
// connection role were the same PostgreSQL role.
//
// THE SEPARATION THIS DEPENDS ON
// Activation is recorded in `FiatLiquidityAuthorityActivation`, owned by a
// dedicated non-login role, with the runtime role holding SELECT only, and
// BEFORE UPDATE/DELETE/TRUNCATE triggers refusing mutation as defence in depth.
// Establishing that is a provisioning step
// (infra/install-authority-activation-roles.js), never something the runtime
// can do to itself: there is no HTTP endpoint and no application code path that
// creates roles, transfers ownership, or grants privileges.
//
// THIS GATE IS CLOSED UNLESS ENFORCEMENT IS OBSERVED AT RUNTIME
// The application does not take the provisioning on trust. Every read asks the
// catalog what it is actually allowed to do and refuses to report the authority
// as enforced unless ALL of the following hold:
//   • the activation table exists and is readable;
//   • the runtime role is not a superuser;
//   • the runtime role does not own the table and cannot SET ROLE to its owner;
//   • the runtime role has SELECT but no INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER;
//   • all three immutability triggers exist and are enabled;
//   • the trigger function is owned by the owner role, not the runtime role.
//
// FAIL CLOSED, NEVER FALL BACK
// Any error, any missing table, any privilege mismatch and any ownership overlap
// yields `enforcedActive: false`. The legacy mutable timestamp is NOT readable
// through this module at all, so it can never activate this gate — see
// docs/authority-activation-enforcement.md.
//
// THIS GATE DOES NOT REPLACE THE REGIME LATCH
// `fiatLiquidityActivationService.readMode()` still decides what
// SystemFiatPool.balance MEANS (GHS vs USDC) and stays monotone. This module
// adds a narrower, stronger authority for capabilities that must be provably
// un-rewritable by the runtime. It never widens what the regime permits.
// =============================================================================

const TABLE_NAME = 'FiatLiquidityAuthorityActivation';
const QUALIFIED_TABLE = `public."${TABLE_NAME}"`;
const TRIGGER_FUNCTION = 'azm_authority_activation_immutable';
const REQUIRED_TRIGGERS = [
    `${TABLE_NAME}_no_update`,
    `${TABLE_NAME}_no_delete`,
    `${TABLE_NAME}_no_truncate`,
];

const REASON = Object.freeze({
    ACTIVE: 'ACTIVE',
    NOT_ACTIVATED: 'NOT_ACTIVATED',
    TABLE_MISSING: 'TABLE_MISSING',
    ENFORCEMENT_UNAVAILABLE: 'ENFORCEMENT_UNAVAILABLE',
    ACTIVATION_UNREADABLE: 'ACTIVATION_UNREADABLE',
});

const PROBLEM = Object.freeze({
    TABLE_MISSING: 'TABLE_MISSING',
    RUNTIME_IS_SUPERUSER: 'RUNTIME_IS_SUPERUSER',
    RUNTIME_OWNS_TABLE: 'RUNTIME_OWNS_TABLE',
    RUNTIME_CAN_SET_ROLE_TO_OWNER: 'RUNTIME_CAN_SET_ROLE_TO_OWNER',
    RUNTIME_CANNOT_READ: 'RUNTIME_CANNOT_READ',
    RUNTIME_CAN_INSERT: 'RUNTIME_CAN_INSERT',
    RUNTIME_CAN_UPDATE: 'RUNTIME_CAN_UPDATE',
    RUNTIME_CAN_DELETE: 'RUNTIME_CAN_DELETE',
    RUNTIME_CAN_TRUNCATE: 'RUNTIME_CAN_TRUNCATE',
    RUNTIME_CAN_CREATE_TRIGGER: 'RUNTIME_CAN_CREATE_TRIGGER',
    TRIGGER_FUNCTION_MISSING: 'TRIGGER_FUNCTION_MISSING',
    TRIGGER_FUNCTION_OWNED_BY_RUNTIME: 'TRIGGER_FUNCTION_OWNED_BY_RUNTIME',
    TRIGGER_MISSING: 'TRIGGER_MISSING',
    TRIGGER_DISABLED: 'TRIGGER_DISABLED',
    ENFORCEMENT_PROBE_FAILED: 'ENFORCEMENT_PROBE_FAILED',
});

/**
 * The gate is unavailable. Deliberately carries NO database, role or privilege
 * detail in its message: it is safe to surface to a client, and the operator
 * detail lives on `.problems` for server-side logging only.
 */
class AuthorityEnforcementUnavailable extends Error {
    constructor(result) {
        super('[WP-E] the database-enforced authority could not be established, so the '
            + 'activation gate stays closed.');
        this.name = 'AuthorityEnforcementUnavailable';
        this.code = 'AUTHORITY_ENFORCEMENT_UNAVAILABLE';
        this.statusCode = 503;
        this.problems = (result && result.problems) || [];
        this.reason = (result && result.reason) || REASON.ENFORCEMENT_UNAVAILABLE;
    }
}

/**
 * Ask PostgreSQL what THIS role is actually permitted to do with the activation
 * record. Read-only: no DDL, no writes, nothing that a runtime role could not
 * safely do on every request.
 */
async function inspectEnforcement(db) {
    const problems = [];
    const diagnostics = { runtimeRole: null, owner: null, tableExists: false };

    let identity;
    try {
        const [row] = await db.$queryRawUnsafe(`
            SELECT current_user AS runtime_role,
                   (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS runtime_superuser,
                   to_regclass('${QUALIFIED_TABLE}') IS NOT NULL AS table_exists
        `);
        identity = row || null;
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
    }

    if (!identity) {
        return { established: false, problems, diagnostics, row: null };
    }

    diagnostics.runtimeRole = identity.runtime_role;
    diagnostics.tableExists = identity.table_exists === true;

    if (identity.runtime_superuser === true) problems.push(PROBLEM.RUNTIME_IS_SUPERUSER);
    if (!diagnostics.tableExists) {
        problems.push(PROBLEM.TABLE_MISSING);
        return { established: false, problems, diagnostics, row: null };
    }

    // Privileges are only meaningful once the relation exists.
    let acl;
    try {
        const [row] = await db.$queryRawUnsafe(`
            SELECT pg_get_userbyid(c.relowner) AS owner,
                   has_table_privilege(current_user, c.oid, 'SELECT')   AS can_select,
                   has_table_privilege(current_user, c.oid, 'INSERT')   AS can_insert,
                   has_table_privilege(current_user, c.oid, 'UPDATE')   AS can_update,
                   has_table_privilege(current_user, c.oid, 'DELETE')   AS can_delete,
                   has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
                   has_table_privilege(current_user, c.oid, 'TRIGGER')  AS can_trigger,
                   pg_has_role(current_user, pg_get_userbyid(c.relowner), 'MEMBER') AS member_of_owner
              FROM pg_class c
             WHERE c.oid = to_regclass('${QUALIFIED_TABLE}')
        `);
        acl = row || null;
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
    }

    if (!acl) return { established: false, problems, diagnostics, row: null };

    diagnostics.owner = acl.owner;
    if (acl.owner === identity.runtime_role) problems.push(PROBLEM.RUNTIME_OWNS_TABLE);
    // Ownership is enough on its own: a member can SET ROLE and then drop or
    // rewrite anything the owner can, whatever the direct privileges say.
    if (acl.member_of_owner === true) problems.push(PROBLEM.RUNTIME_CAN_SET_ROLE_TO_OWNER);
    if (acl.can_select !== true) problems.push(PROBLEM.RUNTIME_CANNOT_READ);
    if (acl.can_insert === true) problems.push(PROBLEM.RUNTIME_CAN_INSERT);
    if (acl.can_update === true) problems.push(PROBLEM.RUNTIME_CAN_UPDATE);
    if (acl.can_delete === true) problems.push(PROBLEM.RUNTIME_CAN_DELETE);
    if (acl.can_truncate === true) problems.push(PROBLEM.RUNTIME_CAN_TRUNCATE);
    if (acl.can_trigger === true) problems.push(PROBLEM.RUNTIME_CAN_CREATE_TRIGGER);

    // Defence in depth must actually be present and enabled.
    try {
        const fnRows = await db.$queryRawUnsafe(`
            SELECT pg_get_userbyid(p.proowner) AS fn_owner
              FROM pg_proc p
             WHERE p.proname = '${TRIGGER_FUNCTION}'
        `);
        if (!fnRows || fnRows.length === 0) {
            problems.push(PROBLEM.TRIGGER_FUNCTION_MISSING);
        } else {
            const fnOwners = new Set(fnRows.map((r) => r.fn_owner));
            if (fnOwners.has(identity.runtime_role)) problems.push(PROBLEM.TRIGGER_FUNCTION_OWNED_BY_RUNTIME);
        }
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
    }

    try {
        const triggerRows = await db.$queryRawUnsafe(`
            SELECT t.tgname, t.tgenabled
              FROM pg_trigger t
             WHERE t.tgrelid = to_regclass('${QUALIFIED_TABLE}')
               AND NOT t.tgisinternal
        `);
        const byName = new Map((triggerRows || []).map((r) => [r.tgname, r.tgenabled]));
        for (const name of REQUIRED_TRIGGERS) {
            if (!byName.has(name)) problems.push(`${PROBLEM.TRIGGER_MISSING}:${name}`);
            else if (byName.get(name) !== 'O') problems.push(`${PROBLEM.TRIGGER_DISABLED}:${name}`);
        }
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
    }

    return { established: problems.length === 0, problems, diagnostics, row: null };
}

/** The single activation record, or null when the database holds none. */
async function readActivationRecord(db) {
    const rows = await db.$queryRawUnsafe(`
        SELECT "id", "activatedAt", "activatedBy", "approvedBy", "evidenceReference", "evidenceDigest"
          FROM ${QUALIFIED_TABLE}
         WHERE "id" = 1
    `);
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    return {
        id: row.id,
        activatedAt: row.activatedAt,
        activatedBy: row.activatedBy,
        approvedBy: row.approvedBy,
        evidenceReference: row.evidenceReference,
        evidenceDigest: row.evidenceDigest,
    };
}

/**
 * The gate. `enforcedActive` is true ONLY when the activation record exists AND
 * runtime enforcement was observed. Everything else is closed.
 *
 * @returns {Promise<{enforcedActive:boolean, enforcementEstablished:boolean,
 *                    reason:string, activation:object|null, problems:string[],
 *                    diagnostics:object}>}
 */
async function readEnforcedAuthority(db) {
    const inspection = await inspectEnforcement(db);
    const base = {
        enforcedActive: false,
        enforcementEstablished: inspection.established,
        reason: REASON.ENFORCEMENT_UNAVAILABLE,
        activation: null,
        problems: inspection.problems,
        diagnostics: inspection.diagnostics,
    };

    if (inspection.problems.includes(PROBLEM.TABLE_MISSING)) {
        return { ...base, reason: REASON.TABLE_MISSING };
    }
    if (!inspection.established) return base;

    let activation;
    try {
        activation = await readActivationRecord(db);
    } catch (_) {
        // An enforceable-looking table that cannot be read is still closed.
        return { ...base, reason: REASON.ACTIVATION_UNREADABLE };
    }

    if (!activation) {
        return { ...base, enforcementEstablished: true, reason: REASON.NOT_ACTIVATED };
    }
    return {
        ...base,
        enforcedActive: true,
        enforcementEstablished: true,
        reason: REASON.ACTIVE,
        activation,
    };
}

/**
 * For capabilities that MUST be backed by a non-rewritable activation record.
 * Throws typed 503 `AUTHORITY_ENFORCEMENT_UNAVAILABLE` — the same shape the rest
 * of the platform uses for a failed fail-closed prerequisite.
 */
async function assertEnforcedAuthority(db) {
    const result = await readEnforcedAuthority(db);
    if (!result.enforcedActive) throw new AuthorityEnforcementUnavailable(result);
    return result;
}

module.exports = {
    REASON,
    PROBLEM,
    TABLE_NAME,
    QUALIFIED_TABLE,
    REQUIRED_TRIGGERS,
    TRIGGER_FUNCTION,
    AuthorityEnforcementUnavailable,
    inspectEnforcement,
    readActivationRecord,
    readEnforcedAuthority,
    assertEnforcedAuthority,
};
