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
//   • the trigger function is owned by the owner role, not the runtime role;
//   • the trigger function's SOURCE TEXT is the canonical shipped body. A body
//     replacement via CREATE OR REPLACE preserves OID, name and owner, so every
//     check above still passes against a no-op trigger. Only the text differs.
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

const {
    CANONICAL_TRIGGER_SOURCE,
    TRIGGER_SOURCE_SHA256,
    TRIGGER_FUNCTION_REGPROCEDURE,
    digestOfTriggerSource,
    isCanonicalTriggerSource,
} = require('./authorityTriggerContract');
const { resolveAuthorityRoles } = require('../../infra/lib/authority-roles');

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
    TRIGGER_IMPLEMENTATION_DRIFT: 'TRIGGER_IMPLEMENTATION_DRIFT',
    TRIGGER_IMPLEMENTATION_UNVERIFIABLE: 'TRIGGER_IMPLEMENTATION_UNVERIFIABLE',
    TRIGGER_MISSING: 'TRIGGER_MISSING',
    TRIGGER_DISABLED: 'TRIGGER_DISABLED',
    ENFORCEMENT_PROBE_FAILED: 'ENFORCEMENT_PROBE_FAILED',
    // §WP-H B3 — the CONNECTION's login identity, not just the effective one.
    // `current_user` is whatever SET ROLE last assumed; a privileged login that
    // assumes a restricted role passes every current_user check while the real
    // connection can RESET ROLE at any moment. The boundary is only proved when
    // the authenticated session identity IS the runtime identity and is itself
    // unprivileged.
    RUNTIME_IDENTITY_ASSUMED: 'RUNTIME_IDENTITY_ASSUMED',
    SESSION_IDENTITY_PRIVILEGED: 'SESSION_IDENTITY_PRIVILEGED',
    SESSION_IDENTITY_UNPROVABLE: 'SESSION_IDENTITY_UNPROVABLE',
    // §WP-H B3 — the activation function is its own boundary. An installer
    // success flag is not a runtime proof.
    ACTIVATION_FUNCTION_MISSING: 'ACTIVATION_FUNCTION_MISSING',
    ACTIVATION_FUNCTION_NOT_SECURITY_DEFINER: 'ACTIVATION_FUNCTION_NOT_SECURITY_DEFINER',
    ACTIVATION_FUNCTION_OWNER_UNSAFE: 'ACTIVATION_FUNCTION_OWNER_UNSAFE',
    RUNTIME_OWNS_FUNCTION: 'RUNTIME_OWNS_FUNCTION',
    RUNTIME_CAN_SET_ROLE_TO_FUNCTION_OWNER: 'RUNTIME_CAN_SET_ROLE_TO_FUNCTION_OWNER',
    RUNTIME_CAN_EXECUTE_ACTIVATION_FUNCTION: 'RUNTIME_CAN_EXECUTE_ACTIVATION_FUNCTION',
    ACTIVATION_FUNCTION_SEARCH_PATH_UNPINNED: 'ACTIVATION_FUNCTION_SEARCH_PATH_UNPINNED',
    PUBLIC_CAN_EXECUTE_ACTIVATION_FUNCTION: 'PUBLIC_CAN_EXECUTE_ACTIVATION_FUNCTION',
    ACTIVATION_FUNCTION_EXECUTE_NOT_PINNED: 'ACTIVATION_FUNCTION_EXECUTE_NOT_PINNED',
    NON_OWNER_CAN_WRITE_ACTIVATION_RECORD: 'NON_OWNER_CAN_WRITE_ACTIVATION_RECORD',
    ACTIVATION_FUNCTION_OWNER_HAS_WIDE_PRIVILEGES: 'ACTIVATION_FUNCTION_OWNER_HAS_WIDE_PRIVILEGES',
    // §WP-H A — the shape of the boundary AROUND the boundary.
    ROLE_MISSING: 'ROLE_MISSING',
    ROLE_ATTRIBUTE_UNSAFE: 'ROLE_ATTRIBUTE_UNSAFE',
    ROLE_HAS_MEMBER: 'ROLE_HAS_MEMBER',
    TRIGGER_BINDING_DRIFT: 'TRIGGER_BINDING_DRIFT',
    TRIGGER_FUNCTION_OWNER_NOT_TABLE_OWNER: 'TRIGGER_FUNCTION_OWNER_NOT_TABLE_OWNER',
    COLUMN_ACL_EXPOSED: 'COLUMN_ACL_EXPOSED',
    PUBLIC_HAS_RECORD_PRIVILEGE: 'PUBLIC_HAS_RECORD_PRIVILEGE',
    RECORD_ACL_FOREIGN_GRANTEE: 'RECORD_ACL_FOREIGN_GRANTEE',
    RECORD_WRITER_PRIVILEGE_TOO_BROAD: 'RECORD_WRITER_PRIVILEGE_TOO_BROAD',
    ACTIVATION_FUNCTION_EXECUTE_TO_RUNTIME: 'ACTIVATION_FUNCTION_EXECUTE_TO_RUNTIME',
    ACTIVATION_FUNCTION_EXECUTE_GRANTEE_NOT_OPERATOR: 'ACTIVATION_FUNCTION_EXECUTE_GRANTEE_NOT_OPERATOR',
    ACTIVATION_FUNCTION_EXECUTE_AMBIGUOUS: 'ACTIVATION_FUNCTION_EXECUTE_AMBIGUOUS',
    BOUNDARY_ATTESTATION_UNVERIFIABLE: 'BOUNDARY_ATTESTATION_UNVERIFIABLE',
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

const ACTIVATION_FUNCTION_REGPROCEDURE = 'public.azm_authority_activate(text,text,text,text,text)';

/**
 * §WP-H B3 — ATTEST THE ACTIVATION FUNCTION ITSELF, from the catalog.
 *
 * Deliberately PROPERTY-based, not name-based: a role whose name looks right
 * proves nothing, and a name that differs proves nothing either. What is
 * attested is what PostgreSQL will actually enforce: who owns the function,
 * whether that owner can log in / create roles / inherit, whether the definer
 * search_path is pinned, who holds EXECUTE, and whether anybody other than the
 * table owner can write the protected record.
 *
 * Every probe reads catalogs (pg_proc / pg_class ACLs) rather than calling
 * has_*_privilege for OTHER roles, because those calls require the caller to be
 * a member of the role being checked — a runtime role is not, and a probe that
 * throws on every request would fail closed forever rather than prove safety.
 */
async function inspectActivationFunction(db, diagnostics, problems) {
    let fn;
    try {
        const rows = await db.$queryRawUnsafe(`
            SELECT p.oid,
                   pg_get_userbyid(p.proowner)              AS fn_owner,
                   p.prosecdef                               AS security_definer,
                   p.proconfig                               AS proconfig,
                   pg_get_userbyid(p.proowner) = current_user AS owned_by_runtime,
                   pg_has_role(current_user, p.proowner, 'MEMBER') AS runtime_member_of_owner,
                   coalesce(r.rolcanlogin, true)             AS owner_can_login,
                   coalesce(r.rolsuper, true)                AS owner_superuser,
                   coalesce(r.rolcreaterole, true)           AS owner_createrole,
                   coalesce(r.rolcreatedb, true)             AS owner_createdb,
                   coalesce(r.rolinherit, true)              AS owner_inherit
              FROM pg_proc p
              LEFT JOIN pg_roles r ON r.oid = p.proowner
             WHERE p.oid = to_regprocedure('${ACTIVATION_FUNCTION_REGPROCEDURE}')
        `);
        fn = (rows && rows[0]) || null;
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
        return;
    }

    if (!fn) {
        problems.push(PROBLEM.ACTIVATION_FUNCTION_MISSING);
        return;
    }

    diagnostics.activationFunction = {
        owner: fn.fn_owner,
        securityDefiner: fn.security_definer === true,
        proconfig: fn.proconfig,
    };

    if (fn.security_definer !== true) problems.push(PROBLEM.ACTIVATION_FUNCTION_NOT_SECURITY_DEFINER);
    if (fn.owned_by_runtime === true) problems.push(PROBLEM.RUNTIME_OWNS_FUNCTION);
    if (fn.runtime_member_of_owner === true) problems.push(PROBLEM.RUNTIME_CAN_SET_ROLE_TO_FUNCTION_OWNER);

    // The definer identity must not be usable by anything else.
    if (fn.owner_can_login === true
        || fn.owner_superuser === true
        || fn.owner_createrole === true
        || fn.owner_createdb === true
        || fn.owner_inherit === true) {
        problems.push(PROBLEM.ACTIVATION_FUNCTION_OWNER_UNSAFE);
    }

    // search_path must be pinned to EXACTLY pg_catalog.
    const proconfig = Array.isArray(fn.proconfig) ? fn.proconfig : [];
    const searchPathSetting = proconfig
        .map((c) => String(c))
        .find((c) => c.toLowerCase().startsWith('search_path='));
    if (!searchPathSetting || searchPathSetting.split('=').slice(1).join('=').trim() !== 'pg_catalog') {
        diagnostics.activationFunction.searchPath = searchPathSetting || null;
        problems.push(PROBLEM.ACTIVATION_FUNCTION_SEARCH_PATH_UNPINNED);
    }

    // EXECUTE must be pinned to exactly ONE non-owner identity, and that identity
    // must not be the runtime. Read from the ACL, not from a privilege probe.
    let execGrants;
    try {
        const rows = await db.$queryRawUnsafe(`
            SELECT a.grantee::text                AS grantee_oid,
                   CASE WHEN a.grantee = 0::oid THEN 'PUBLIC'
                        ELSE pg_get_userbyid(a.grantee) END AS grantee,
                   a.is_grantable                 AS grantable
              FROM pg_proc p
              CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE p.oid = to_regprocedure('${ACTIVATION_FUNCTION_REGPROCEDURE}')
               AND a.privilege_type = 'EXECUTE'
               AND a.grantee <> p.proowner
        `);
        execGrants = rows || [];
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
        return;
    }

    const publicExec = execGrants.some((g) => g.grantee_oid === '0' || g.grantee === 'PUBLIC');
    if (publicExec) problems.push(PROBLEM.PUBLIC_CAN_EXECUTE_ACTIVATION_FUNCTION);

    const runtimeExec = execGrants.some((g) => g.grantee === diagnostics.runtimeRole);
    if (runtimeExec) problems.push(PROBLEM.RUNTIME_CAN_EXECUTE_ACTIVATION_FUNCTION);

    const namedExec = execGrants.filter((g) => g.grantee !== 'PUBLIC' && g.grantee !== diagnostics.runtimeRole);
    diagnostics.activationFunction.executeGrantees = namedExec.map((g) => g.grantee);
    if (namedExec.length !== 1) problems.push(PROBLEM.ACTIVATION_FUNCTION_EXECUTE_NOT_PINNED);

    // Who may write the protected record. The table owner holds everything. The
    // FUNCTION OWNER holds INSERT and nothing else — that INSERT is the whole
    // point of the SECURITY DEFINER body, so it is allowed here and only here.
    // Every other grantee with any write privilege is the bypass the function
    // exists to prevent, including the operator and PUBLIC.
    try {
        const rows = await db.$queryRawUnsafe(`
            SELECT CASE WHEN a.grantee = 0::oid THEN 'PUBLIC'
                        ELSE pg_get_userbyid(a.grantee) END AS grantee,
                   a.privilege_type                       AS privilege_type
              FROM pg_class c
              CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             WHERE c.oid = to_regclass('${QUALIFIED_TABLE}')
               AND a.grantee <> c.relowner
               AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
        `);
        const functionOwner = diagnostics.activationFunction && diagnostics.activationFunction.owner;
        const illegal = [];
        const allowed = [];
        for (const r of rows || []) {
            const entry = `${r.grantee}:${r.privilege_type}`;
            if (r.grantee === functionOwner && r.privilege_type === 'INSERT') allowed.push(entry);
            else illegal.push(entry);
        }
        diagnostics.activationRecordWriters = illegal;
        diagnostics.activationRecordWritersAllowed = allowed;
        if (illegal.length > 0) problems.push(PROBLEM.NON_OWNER_CAN_WRITE_ACTIVATION_RECORD);
    } catch (_) {
        problems.push(PROBLEM.ENFORCEMENT_PROBE_FAILED);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// §WP-H A — ATTEST THE ENTIRE BOUNDARY, NOT JUST THE PARTS THAT ARE EASY TO READ.
//
// The checks above establish that the runtime cannot write, that the trigger
// function is canonical, that the triggers exist and are enabled, and that the
// activation function is a pinned SECURITY DEFINER. None of that describes the
// shape of the boundary AROUND those facts, and each gap is a way in:
//
//   * an owner that can LOG IN, create roles, replicate or bypass RLS is a
//     second identity that can simply be assumed;
//   * a role that is a member of the owner — directly or through a chain — can
//     SET ROLE to it, which no privilege check on the runtime ever reveals;
//   * a trigger with the right name but a different relation, function, timing
//     or scope is not this trigger;
//   * a table-level grant hides a column-level one, and a PUBLIC grant hides
//     behind OID 0 rather than a role name;
//   * an EXECUTE grantee is only acceptable if it is the CONFIGURED operator,
//     not merely a differently-named role that happens to hold the privilege.
//
// Everything below reads pg_catalog. Nothing trusts the installer, an env flag
// or a previous success, so drift after provisioning is detected. Any catalog
// that cannot be read is a refusal, never a pass.
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_ATTRIBUTE_RULES = Object.freeze([
    { column: 'rolcanlogin', label: 'LOGIN' },
    { column: 'rolsuper', label: 'SUPERUSER' },
    { column: 'rolcreatedb', label: 'CREATEDB' },
    { column: 'rolcreaterole', label: 'CREATEROLE' },
    { column: 'rolreplication', label: 'REPLICATION' },
    { column: 'rolbypassrls', label: 'BYPASSRLS' },
    { column: 'rolinherit', label: 'INHERIT' },
]);

// pg_trigger.tgtype bit masks, straight from the catalog format.
const TG_ROW = 1;
const TG_BEFORE = 2;
const TG_DELETE = 8;
const TG_UPDATE = 16;
const TG_TRUNCATE = 32;
const TG_INSTEAD = 64;

const EXPECTED_TRIGGER_BINDINGS = Object.freeze({
    [`${TABLE_NAME}_no_update`]: TG_ROW | TG_BEFORE | TG_UPDATE,
    [`${TABLE_NAME}_no_delete`]: TG_ROW | TG_BEFORE | TG_DELETE,
    [`${TABLE_NAME}_no_truncate`]: TG_BEFORE | TG_TRUNCATE,
});

const TRUTHY = (v) => v === true || v === 't' || v === 'true' || v === 1;
const TABLE_WRITE_LETTERS = new Set(['w', 'a', 'd', 'D', 'x', 't', 'm']);
const stripQuotes = (name) => String(name ?? '').replace(/^"|"$/g, '').trim();

/**
 * Parse a PostgreSQL aclitem[] rendered as text.
 *
 * Splitting on ',' would break a quoted role name containing one, so the split
 * tracks quote state. The PUBLIC grantee is the EMPTY name (OID 0) and is
 * returned with `isPublic`, because "no role named here" is exactly how a
 * privilege reaches every role in the cluster.
 */
function parseAclEntries(raw) {
    const text = String(raw ?? '').trim();
    if (!text || text === '{}') return [];
    const inner = text.replace(/^\{/, '').replace(/\}$/, '');
    if (!inner.trim()) return [];
    const parts = [];
    let quoted = false;
    let current = '';
    for (const ch of inner) {
        if (ch === '"') quoted = !quoted;
        if (ch === ',' && !quoted) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    parts.push(current);
    return parts.filter(Boolean).map((entry) => {
        const slash = entry.lastIndexOf('/');
        const left = slash === -1 ? entry : entry.slice(0, slash);
        const eq = left.indexOf('=');
        const granteeRaw = eq === -1 ? left : left.slice(0, eq);
        const privs = eq === -1 ? '' : left.slice(eq + 1);
        const grantee = stripQuotes(granteeRaw);
        return { grantee, privs: privs.trim(), isPublic: grantee === '' };
    });
}

async function inspectRoleAttributes(db, roleName, label, problems, diagnostics) {
    if (!roleName) { problems.push(`${PROBLEM.ROLE_MISSING}:${label}`); return; }
    try {
        const [row] = await db.$queryRawUnsafe(
            `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                    rolreplication, rolbypassrls, rolinherit
               FROM pg_roles WHERE rolname = $1`, roleName);
        if (!row) { problems.push(`${PROBLEM.ROLE_MISSING}:${label}:${roleName}`); return; }
        const seen = {};
        for (const rule of ROLE_ATTRIBUTE_RULES) {
            const on = TRUTHY(row[rule.column]);
            seen[rule.label] = on;
            if (on) problems.push(`${PROBLEM.ROLE_ATTRIBUTE_UNSAFE}:${label}:${rule.label}`);
        }
        diagnostics[`${label}Attributes`] = seen;
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:${label}-attributes`);
    }
}

async function inspectMembershipReachability(db, roleName, label, problems, diagnostics) {
    if (!roleName) return;
    try {
        // RECURSIVE, because the dangerous path is the indirect one: a role is a
        // member of a member of the owner and can still SET ROLE to it. A check
        // that lists known names can never see that; the catalog can.
        const rows = await db.$queryRawUnsafe(`
            WITH RECURSIVE reachable(member_oid) AS (
                SELECT m.member
                  FROM pg_auth_members m
                 WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
                UNION
                SELECT m.member
                  FROM pg_auth_members m
                  JOIN reachable r ON m.roleid = r.member_oid
            )
            SELECT DISTINCT pg_get_userbyid(reachable.member_oid) AS member
              FROM reachable
        `, roleName);
        const members = (rows || [])
            .map((r) => r.member)
            .filter((name) => name && name !== roleName);
        diagnostics[`${label}Members`] = members;
        for (const member of members) problems.push(`${PROBLEM.ROLE_HAS_MEMBER}:${label}:${member}`);
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:${label}-members`);
    }
}

async function inspectTriggerBindings(db, tableOwner, problems, diagnostics) {
    try {
        const rows = await db.$queryRawUnsafe(`
            SELECT t.tgname,
                   t.tgenabled,
                   t.tgtype,
                   t.tgnargs,
                   (t.tgqual IS NOT NULL)                                   AS has_when,
                   t.tgfoid::text                                           AS tgfoid,
                   to_regprocedure('${TRIGGER_FUNCTION_REGPROCEDURE}')::oid::text AS expected_foid,
                   pg_get_userbyid(p.proowner)                             AS fn_owner,
                   n.nspname                                               AS fn_schema,
                   c.relname                                               AS rel_name
              FROM pg_trigger t
              JOIN pg_proc p      ON p.oid = t.tgfoid
              JOIN pg_namespace n ON n.oid = p.pronamespace
              JOIN pg_class c     ON c.oid = t.tgrelid
             WHERE t.tgrelid = to_regclass('${QUALIFIED_TABLE}')
               AND NOT t.tgisinternal
        `);
        const seen = new Map();
        for (const row of rows || []) {
            seen.set(row.tgname, row);
            const expected = EXPECTED_TRIGGER_BINDINGS[row.tgname];
            if (expected === undefined) {
                problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:unexpected`);
                continue;
            }
            const actual = Number(row.tgtype) & ~TG_INSTEAD;
            if (actual !== expected) problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:timing-or-scope`);
            if (row.tgenabled !== 'O') problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:not-enabled`);
            if (Number(row.tgnargs) !== 0) problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:has-arguments`);
            if (TRUTHY(row.has_when)) problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:conditional`);
            if (row.expected_foid && String(row.tgfoid) !== String(row.expected_foid)) {
                problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:wrong-function`);
            }
            if (row.fn_schema !== 'public') problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${row.tgname}:function-schema`);
            // Not "different from runtime": EXACTLY the table owner.
            if (tableOwner && row.fn_owner !== tableOwner) {
                problems.push(`${PROBLEM.TRIGGER_FUNCTION_OWNER_NOT_TABLE_OWNER}:${row.tgname}`);
            }
        }
        for (const name of REQUIRED_TRIGGERS) {
            if (!seen.has(name)) problems.push(`${PROBLEM.TRIGGER_BINDING_DRIFT}:${name}:missing`);
        }
        diagnostics.triggerBindings = [...seen.keys()];
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:trigger-bindings`);
    }
}

async function inspectRecordAcl(db, identities, problems, diagnostics) {
    let row;
    try {
        [row] = await db.$queryRawUnsafe(`
            SELECT c.relacl::text AS relacl,
                   COALESCE((
                       SELECT array_to_string(
                                  array_agg(a.attname || '=>' || a.attacl::text), '|')
                         FROM pg_attribute a
                        WHERE a.attrelid = c.oid
                          AND a.attnum > 0
                          AND NOT a.attisdropped
                          AND a.attacl IS NOT NULL
                   ), '') AS colacl
              FROM pg_class c
             WHERE c.oid = to_regclass('${QUALIFIED_TABLE}')
        `);
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:record-acl`);
        return;
    }
    if (!row) { problems.push(PROBLEM.TABLE_MISSING); return; }

    for (const part of String(row.colacl || '').split('|').filter(Boolean)) {
        problems.push(`${PROBLEM.COLUMN_ACL_EXPOSED}:${part.split('=>')[0]}`);
    }

    const kinds = new Map();
    if (identities.owner) kinds.set(identities.owner, 'owner');
    if (identities.writer) kinds.set(identities.writer, 'writer');
    for (const reader of identities.readers) if (reader) kinds.set(reader, 'reader');

    for (const entry of parseAclEntries(row.relacl)) {
        if (entry.isPublic) {
            if (entry.privs) problems.push(`${PROBLEM.PUBLIC_HAS_RECORD_PRIVILEGE}:${entry.privs}`);
            continue;
        }
        const kind = kinds.get(entry.grantee);
        if (!kind) { problems.push(`${PROBLEM.RECORD_ACL_FOREIGN_GRANTEE}:${entry.grantee}`); continue; }
        if (kind === 'owner') continue;
        if (kind === 'writer') {
            // The one intended non-owner writer, and ONLY its insert.
            // SELECT + INSERT is the sanctioned writer set (infra/lib/authority-role-
            // normalisation.js): the definer function reads the singleton it guards.
            // Anything that can OVERWRITE or REMOVE the record is not sanctioned.
            const beyondInsert = entry.privs.split('').filter((ch) => ch !== '' && ch !== 'a' && ch !== 'r');
            if (beyondInsert.length) {
                problems.push(`${PROBLEM.RECORD_WRITER_PRIVILEGE_TOO_BROAD}:${entry.grantee}:${beyondInsert.join('')}`);
            }
            continue;
        }
        const writes = entry.privs.split('').filter((ch) => TABLE_WRITE_LETTERS.has(ch));
        if (writes.length) {
            problems.push(`${PROBLEM.NON_OWNER_CAN_WRITE_ACTIVATION_RECORD}:${entry.grantee}:${writes.join('')}`);
        }
    }
}

/**
 * WHICH identity may activate. Derived from the CATALOG, not from a name this
 * module hopes was configured: whoever actually holds EXECUTE on the SECURITY
 * DEFINER function is the operator, whatever it is called. That inverts the
 * older name comparison, which reported a perfectly safe boundary as broken
 * whenever the deployment used different role names — and would equally have
 * blessed a role that merely shared the configured name.
 *
 * The configured role is then an INTENT check: if AUTHORITY_OPERATOR_ROLE is set
 * explicitly, the catalog must agree with it. Silence in the environment is not
 * an assertion, so an unset variable proves nothing either way.
 *
 * Returns the derived operator (or null) so the record ACL is judged against the
 * identity that really holds the capability.
 */
async function inspectActivationExecuteGrantee(db, identities, problems, diagnostics) {
    let row;
    try {
        [row] = await db.$queryRawUnsafe(`
            SELECT p.proacl::text AS acl,
                   pg_get_userbyid(p.proowner) AS fn_owner
              FROM pg_proc p
             WHERE p.oid = to_regprocedure('${ACTIVATION_FUNCTION_REGPROCEDURE}')
        `);
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:activation-execute`);
        return { operator: null };
    }
    if (!row) { problems.push(PROBLEM.ACTIVATION_FUNCTION_MISSING); return { operator: null }; }
    diagnostics.activationFunctionOwner = row.fn_owner;

    // A NULL acl is NOT "no grants": PostgreSQL's default grants EXECUTE to
    // PUBLIC, so an unset acl is the widest possible state and must fail.
    if (!row.acl) {
        problems.push(PROBLEM.PUBLIC_CAN_EXECUTE_ACTIVATION_FUNCTION);
        return { operator: null };
    }

    const candidates = [];
    for (const entry of parseAclEntries(row.acl)) {
        if (!entry.privs.includes('X')) continue;
        if (entry.isPublic) { problems.push(PROBLEM.PUBLIC_CAN_EXECUTE_ACTIVATION_FUNCTION); continue; }
        if (entry.grantee === row.fn_owner || entry.grantee === identities.owner) continue;
        if (entry.grantee === identities.runtime) {
            problems.push(PROBLEM.ACTIVATION_FUNCTION_EXECUTE_TO_RUNTIME);
            continue;
        }
        candidates.push(entry.grantee);
    }

    if (candidates.length === 0) {
        problems.push(`${PROBLEM.ACTIVATION_FUNCTION_EXECUTE_GRANTEE_NOT_OPERATOR}:none-granted`);
        return { operator: null };
    }
    if (candidates.length > 1) {
        // Two non-owner EXECUTE identities is an ambiguous boundary, and the
        // tests must not silently pick one.
        diagnostics.activationExecuteCandidates = candidates;
        problems.push(`${PROBLEM.ACTIVATION_FUNCTION_EXECUTE_AMBIGUOUS}:${candidates.join(',')}`);
        return { operator: null };
    }

    const operator = candidates[0];
    diagnostics.activationOperator = operator;

    const configured = String(process.env.AUTHORITY_OPERATOR_ROLE || '').trim();
    if (configured && configured !== operator) {
        problems.push(`${PROBLEM.ACTIVATION_FUNCTION_EXECUTE_GRANTEE_NOT_OPERATOR}:${operator}:configured-is-${configured}`);
    }
    return { operator };
}

async function inspectBoundaryAttestation(db, diagnostics, problems) {
    const roles = resolveAuthorityRoles({}, process.env);
    diagnostics.attestedRoles = { owner: roles.owner, operator: roles.operator, runtime: roles.runtime, functionOwner: roles.functionOwner };

    let tableOwner = null;
    try {
        const [row] = await db.$queryRawUnsafe(
            `SELECT pg_get_userbyid(c.relowner) AS owner
               FROM pg_class c WHERE c.oid = to_regclass('${QUALIFIED_TABLE}')`);
        tableOwner = (row && row.owner) || null;
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:table-owner`);
        return;
    }
    diagnostics.tableOwner = tableOwner;
    if (!tableOwner) { problems.push(PROBLEM.TABLE_MISSING); return; }

    let activationOwner = null;
    try {
        const [row] = await db.$queryRawUnsafe(
            `SELECT pg_get_userbyid(p.proowner) AS owner
               FROM pg_proc p WHERE p.oid = to_regprocedure('${ACTIVATION_FUNCTION_REGPROCEDURE}')`);
        activationOwner = (row && row.owner) || null;
    } catch (_) {
        problems.push(`${PROBLEM.BOUNDARY_ATTESTATION_UNVERIFIABLE}:activation-owner`);
    }

    await inspectRoleAttributes(db, tableOwner, 'owner', problems, diagnostics);
    await inspectRoleAttributes(db, activationOwner, 'functionOwner', problems, diagnostics);
    await inspectMembershipReachability(db, tableOwner, 'owner', problems, diagnostics);
    await inspectMembershipReachability(db, activationOwner, 'functionOwner', problems, diagnostics);
    await inspectTriggerBindings(db, tableOwner, problems, diagnostics);

    // Derived first: the record ACL is judged against the identity that ACTUALLY
    // holds the activation capability, and against the runtime that is connected.
    const { operator } = await inspectActivationExecuteGrantee(
        db,
        { owner: tableOwner, runtime: diagnostics.runtimeRole },
        problems,
        diagnostics,
    );
    await inspectRecordAcl(
        db,
        {
            owner: tableOwner,
            writer: activationOwner,
            readers: [diagnostics.runtimeRole, operator].filter(Boolean),
        },
        problems,
        diagnostics,
    );
}

async function inspectEnforcement(db) {
    const problems = [];
    const diagnostics = { runtimeRole: null, owner: null, tableExists: false };

    let identity;
    try {
        const [row] = await db.$queryRawUnsafe(`
            SELECT current_user  AS runtime_role,
                   session_user  AS session_login,
                   (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)  AS runtime_superuser,
                   (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)  AS session_superuser,
                   (SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user) AS session_createrole,
                   (SELECT rolcreatedb  FROM pg_roles WHERE rolname = session_user) AS session_createdb,
                   (SELECT rolreplication FROM pg_roles WHERE rolname = session_user) AS session_replication,
                   (SELECT rolbypassrls FROM pg_roles WHERE rolname = session_user) AS session_bypassrls,
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
    diagnostics.sessionLogin = identity.session_login == null ? null : String(identity.session_login);
    diagnostics.tableExists = identity.table_exists === true;

    if (identity.runtime_superuser === true) problems.push(PROBLEM.RUNTIME_IS_SUPERUSER);

    // ── THE CONNECTION IDENTITY ─────────────────────────────────────────────
    // Everything below this point inspects privileges of `current_user`. If the
    // session logged in as someone else and assumed the runtime role, those
    // privileges describe a mask: `RESET ROLE` restores the real identity at any
    // moment, so the boundary is not proved. An unprovable session identity
    // fails closed as UNKNOWN rather than being assumed benign.
    const sessionLogin = identity.session_login == null ? null : String(identity.session_login);
    // NOT an early return. Returning here truncated the problem list at the FIRST
    // identity finding, so the release-chain verifier never saw TABLE_MISSING /
    // TRIGGER_FUNCTION_MISSING / ACTIVATION_FUNCTION_MISSING and classified a
    // never-provisioned database as DRIFT instead of NOT_PROVISIONED. That is a
    // false alarm that blocks a deploy for the wrong reason (measured in CI on
    // df1998e7). The identity verdict is recorded, and discovery continues.
    let identityProven = true;
    if (!sessionLogin) {
        problems.push(PROBLEM.SESSION_IDENTITY_UNPROVABLE);
        identityProven = false;
    } else if (sessionLogin !== String(identity.runtime_role)) {
        problems.push(PROBLEM.RUNTIME_IDENTITY_ASSUMED);
        identityProven = false;
    } else if (identity.session_superuser === true
        || identity.session_createrole === true
        || identity.session_createdb === true
        || identity.session_replication === true
        || identity.session_bypassrls === true) {
        problems.push(PROBLEM.SESSION_IDENTITY_PRIVILEGED);
        identityProven = false;
    }
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
    // Direct-privilege readings describe `current_user`. When the connection
    // identity is unproven those readings describe a mask, so they are recorded in
    // diagnostics but not asserted as problems: the identity problem above is the
    // finding, and duplicating it per privilege would bury it.
    if (identityProven) {
        if (acl.can_select !== true) problems.push(PROBLEM.RUNTIME_CANNOT_READ);
        if (acl.can_insert === true) problems.push(PROBLEM.RUNTIME_CAN_INSERT);
        if (acl.can_update === true) problems.push(PROBLEM.RUNTIME_CAN_UPDATE);
        if (acl.can_delete === true) problems.push(PROBLEM.RUNTIME_CAN_DELETE);
        if (acl.can_truncate === true) problems.push(PROBLEM.RUNTIME_CAN_TRUNCATE);
        if (acl.can_trigger === true) problems.push(PROBLEM.RUNTIME_CAN_CREATE_TRIGGER);
    }

    // Defence in depth must actually be present and enabled.
    try {
        // Resolved by signature, not by bare name: a same-named function in
        // another schema is not this boundary.
        const fnRows = await db.$queryRawUnsafe(`
            SELECT pg_get_userbyid(p.proowner)                      AS fn_owner,
                   p.prosrc                                          AS body,
                   l.lanname                                         AS language,
                   p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype AS returns_trigger
              FROM pg_proc p
              JOIN pg_language l ON l.oid = p.prolang
             WHERE p.oid = to_regprocedure('${TRIGGER_FUNCTION_REGPROCEDURE}')
        `);
        if (!fnRows || fnRows.length === 0) {
            problems.push(PROBLEM.TRIGGER_FUNCTION_MISSING);
        } else {
            const fn = fnRows[0];
            if (fn.fn_owner === identity.runtime_role) problems.push(PROBLEM.TRIGGER_FUNCTION_OWNED_BY_RUNTIME);

            // THE IMPLEMENTATION, not just its identity. This is the check that
            // a CREATE OR REPLACE body swap cannot survive.
            if (typeof fn.body !== 'string') {
                problems.push(PROBLEM.TRIGGER_IMPLEMENTATION_UNVERIFIABLE);
            } else {
                diagnostics.triggerFunctionDigest = digestOfTriggerSource(fn.body);
                diagnostics.expectedTriggerDigest = TRIGGER_SOURCE_SHA256;
                if (fn.language !== 'plpgsql' || fn.returns_trigger !== true) {
                    diagnostics.triggerFunctionLanguage = fn.language;
                    problems.push(PROBLEM.TRIGGER_IMPLEMENTATION_DRIFT);
                } else if (!isCanonicalTriggerSource(fn.body)) {
                    problems.push(PROBLEM.TRIGGER_IMPLEMENTATION_DRIFT);
                }
            }
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

    // §WP-H B3: the activation function boundary is attested last, because it is
    // only meaningful once the table and triggers it protects are established.
    await inspectActivationFunction(db, diagnostics, problems);

    // §WP-H A: the shape of the boundary around those facts.
    await inspectBoundaryAttestation(db, diagnostics, problems);

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
    CANONICAL_TRIGGER_SOURCE,
    AuthorityEnforcementUnavailable,
    inspectEnforcement,
    readActivationRecord,
    readEnforcedAuthority,
    assertEnforcedAuthority,
};
