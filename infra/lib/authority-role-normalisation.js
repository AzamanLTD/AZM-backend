// infra/lib/authority-role-normalisation.js
// =============================================================================
// §WP-H — LEAST PRIVILEGE FOR THE ACTIVATION FUNCTION OWNER.
//
// THE FINDING THIS CLOSES
// The installer created a narrow function-owner role when it was absent, but
// never normalised one that already existed. A role pre-created by an attacker
// with broad grants over public tables, a membership in a privilege-bearing
// role and the right attributes came out the other side untouched: the install
// returned exit code 0 while the activation function's owner still held 1,554
// table privileges. Since the activation function is SECURITY DEFINER, its
// owner's privileges ARE the function's privileges.
//
// WHAT NORMALISATION MEANS HERE
//   1. attributes: no LOGIN, no SUPERUSER, no CREATEDB, no CREATEROLE,
//      no REPLICATION, no BYPASSRLS, NOINHERIT (so membership confers nothing);
//   2. memberships: every membership involving the role, in BOTH directions,
//      revoked — not just the four role names this deployment knows about;
//   3. grants: every direct table, column, sequence, routine and schema
//      privilege revoked, from the catalog, before the allowlist is applied;
//   4. ownership: audited. The sanctioned activation function is the only
//      object it may own; anything else fails the install with diagnostics,
//      because silently re-parenting an attacker's objects is not safe;
//   5. verification: the resulting catalog state is measured with
//      has_table_privilege / has_column_privilege / pg_auth_members /
//      ownership catalogs and compared to the allowlist. The install fails on
//      any difference. Running the GRANT statements is not evidence.
//
// PARTIAL STATES
// Normalisation, provisioning and the final verification all run in a
// sequential install; any failure leaves report.ok === false and the CLI exits
// non-zero. A partially provisioned role can therefore never be read as a valid
// boundary, and the runtime gate re-derives the same properties on every read,
// so even an interrupted install reads as UNKNOWN rather than as enforced.
// =============================================================================
'use strict';

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

const EXPECTED_TABLE_PRIVILEGES = {
    'public.FiatLiquidityAuthorityActivation': ['SELECT', 'INSERT'],
    'public.FiatLiquidityState': ['SELECT'],
    'public.GlobalSettings': ['SELECT'],
    'public.SystemFiatPool': ['SELECT'],
    'public.Withdrawal': ['SELECT'],
    'public.TransactionHistory': ['SELECT'],
    'public.FiatLiquidityReservation': ['SELECT'],
    'public.AdminSettingsAuditLog': ['INSERT'],
};

const EXPECTED_COLUMN_UPDATE = {
    'public.FiatLiquidityState': ['authorityActivatedAt'],
    'public.GlobalSettings': ['fiatLiquidityAuthorityEnabled'],
    'public.SystemFiatPool': ['balance'],
};

/** The one deliberate exception: the sanctioned activation function itself. */
const ALLOWED_OWNED_ROUTINE_PREFIX = 'public.azm_authority_activate(';
const isAllowedOwnedRoutine = (name) => String(name).startsWith(ALLOWED_OWNED_ROUTINE_PREFIX);

const { revokeDefaultPrivileges, inspectDefaultPrivileges } = require('./authority-default-acl');

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const notSystem = SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(',');

function roleOidSubquery() {
    return '(SELECT oid FROM pg_roles WHERE rolname = $1)';
}

async function reconcileAttributes(prisma, role, applied) {
    await prisma.$executeRawUnsafe(
        `ALTER ROLE ${q(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    applied.push(`attributes: ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
}

async function reconcileMemberships(prisma, role, applied) {
    const rows = await prisma.$queryRawUnsafe(`
        SELECT g.rolname AS group_role, m.rolname AS member_role
          FROM pg_auth_members am
          JOIN pg_roles g ON g.oid = am.roleid
          JOIN pg_roles m ON m.oid = am.member
         WHERE am.member = ${roleOidSubquery()} OR am.roleid = ${roleOidSubquery()}`, role, role);
    const revoked = [];
    for (const row of rows || []) {
        await prisma.$executeRawUnsafe(`REVOKE ${q(row.group_role)} FROM ${q(row.member_role)}`);
        revoked.push(`${row.group_role}->${row.member_role}`);
    }
    if (revoked.length) applied.push(`revoked memberships: ${revoked.join(', ')}`);
    return revoked;
}

async function revokeDirectPrivileges(prisma, role, applied) {
    const oid = roleOidSubquery();

    const relations = await prisma.$queryRawUnsafe(`
        SELECT n.nspname, c.relname, c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
         WHERE a.grantee = ${oid}
           AND c.relowner <> ${oid}
           AND n.nspname NOT IN (${notSystem})
         GROUP BY 1,2,3`, role, role);
    let count = 0;
    for (const r of relations || []) {
        const kind = r.relkind === 'S' ? 'SEQUENCE' : 'TABLE';
        await prisma.$executeRawUnsafe(
            `REVOKE ALL PRIVILEGES ON ${kind} ${q(r.nspname)}.${q(r.relname)} FROM ${q(role)}`);
        count += 1;
    }

    const columns = await prisma.$queryRawUnsafe(`
        SELECT n.nspname, c.relname, att.attname
          FROM pg_attribute att
          JOIN pg_class c ON c.oid = att.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(att.attacl) a
         WHERE a.grantee = ${oid}
           AND att.attacl IS NOT NULL
           AND NOT att.attisdropped
           AND c.relowner <> ${oid}
           AND n.nspname NOT IN (${notSystem})
         GROUP BY 1,2,3`, role, role);
    for (const c of columns || []) {
        await prisma.$executeRawUnsafe(
            `REVOKE ALL PRIVILEGES (${q(c.attname)}) ON TABLE ${q(c.nspname)}.${q(c.relname)} FROM ${q(role)}`);
        count += 1;
    }

    const routines = await prisma.$queryRawUnsafe(`
        SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE a.grantee = ${oid}
           AND p.proacl IS NOT NULL
           AND p.proowner <> ${oid}
           AND n.nspname NOT IN (${notSystem})
         GROUP BY 1`, role, role);
    for (const r of routines || []) {
        await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON ROUTINE ${r.signature} FROM ${q(role)}`);
        count += 1;
    }

    const schemas = await prisma.$queryRawUnsafe(`
        SELECT n.nspname
          FROM pg_namespace n
          CROSS JOIN LATERAL aclexplode(n.nspacl) a
         WHERE a.grantee = ${oid}
           AND n.nspacl IS NOT NULL
           AND n.nspowner <> ${oid}
           AND n.nspname NOT IN (${notSystem})
         GROUP BY 1`, role, role);
    for (const s of schemas || []) {
        await prisma.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON SCHEMA ${q(s.nspname)} FROM ${q(role)}`);
        count += 1;
    }

    applied.push(`revoked ${count} direct object privilege entries from ${role}`);
    return count;
}

async function auditOwnership(prisma, role, problems) {
    const owned = await prisma.$queryRawUnsafe(`
        SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS object
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relowner = ${roleOidSubquery()} AND n.nspname NOT IN (${notSystem})
        UNION ALL
        SELECT 'schema', n.nspname
          FROM pg_namespace n
         WHERE n.nspowner = ${roleOidSubquery()} AND n.nspname NOT IN (${notSystem})
        UNION ALL
        SELECT 'routine', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proowner = ${roleOidSubquery()} AND n.nspname NOT IN (${notSystem})
        UNION ALL
        SELECT 'database', d.datname
          FROM pg_database d
         WHERE d.datdba = ${roleOidSubquery()}`, role, role, role, role);

    const unexpected = (owned || []).filter(
        (o) => !(o.kind === 'routine' && isAllowedOwnedRoutine(o.object)));
    for (const o of unexpected) {
        problems.push(`${role} owns an unexpected ${o.kind}: ${o.object}`);
    }
    return { owned: owned || [], unexpected };
}

async function verifyResult(prisma, role, problems) {
    const [attrs] = await prisma.$queryRawUnsafe(`
        SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
               rolbypassrls, rolinherit
          FROM pg_roles WHERE rolname = $1`, role);
    if (!attrs) {
        problems.push(`role ${role} is missing after installation`);
        return { attributes: null };
    }
    for (const [flag, label] of [
        ['rolcanlogin', 'LOGIN'], ['rolsuper', 'SUPERUSER'], ['rolcreatedb', 'CREATEDB'],
        ['rolcreaterole', 'CREATEROLE'], ['rolreplication', 'REPLICATION'],
        ['rolbypassrls', 'BYPASSRLS'], ['rolinherit', 'INHERIT'],
    ]) {
        if (attrs[flag] === true) problems.push(`role ${role} still has ${label}`);
    }

    const memberships = await prisma.$queryRawUnsafe(`
        SELECT g.rolname AS group_role, m.rolname AS member_role
          FROM pg_auth_members am
          JOIN pg_roles g ON g.oid = am.roleid
          JOIN pg_roles m ON m.oid = am.member
         WHERE am.member = ${roleOidSubquery()} OR am.roleid = ${roleOidSubquery()}`, role, role);
    for (const m of memberships || []) {
        problems.push(`role ${role} still participates in membership ${m.group_role}->${m.member_role}`);
    }

    const relations = await prisma.$queryRawUnsafe(`
        SELECT n.nspname || '.' || c.relname AS rel, c.relkind,
               has_table_privilege($1, c.oid, 'SELECT')     AS s,
               has_table_privilege($1, c.oid, 'INSERT')     AS i,
               has_table_privilege($1, c.oid, 'UPDATE')     AS u,
               has_table_privilege($1, c.oid, 'DELETE')     AS d,
               has_table_privilege($1, c.oid, 'TRUNCATE')   AS t,
               has_table_privilege($1, c.oid, 'REFERENCES') AS r,
               has_table_privilege($1, c.oid, 'TRIGGER')    AS g
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','p','v','m','f','S')
           AND n.nspname NOT IN (${notSystem})`, role);

    const observed = {};
    for (const rel of relations || []) {
        const flags = [];
        if (rel.s) flags.push('SELECT');
        if (rel.i) flags.push('INSERT');
        if (rel.u) flags.push('UPDATE');
        if (rel.d) flags.push('DELETE');
        if (rel.t) flags.push('TRUNCATE');
        if (rel.r) flags.push('REFERENCES');
        if (rel.g) flags.push('TRIGGER');
        if (flags.length) observed[rel.rel] = { kind: rel.relkind, flags: flags.sort() };
    }
    for (const [rel, entry] of Object.entries(observed)) {
        if (entry.kind === 'S') {
            problems.push(`role ${role} holds sequence privilege on ${rel}`);
            continue;
        }
        const expected = (EXPECTED_TABLE_PRIVILEGES[rel] || []).slice().sort();
        if (JSON.stringify(entry.flags) !== JSON.stringify(expected)) {
            problems.push(`role ${role} holds ${entry.flags.join('+')} on ${rel}, expected ${expected.join('+') || 'none'}`);
        }
    }
    for (const rel of Object.keys(EXPECTED_TABLE_PRIVILEGES)) {
        if (!observed[rel]) {
            const exists = (relations || []).some((r) => r.rel === rel);
            if (exists) problems.push(`role ${role} has no privileges on ${rel}, expected ${EXPECTED_TABLE_PRIVILEGES[rel].join('+')}`);
        }
    }

    const columnUpdates = await prisma.$queryRawUnsafe(`
        SELECT n.nspname || '.' || c.relname AS rel, att.attname
          FROM pg_attribute att
          JOIN pg_class c ON c.oid = att.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE att.attnum > 0 AND NOT att.attisdropped
           AND c.relkind IN ('r','p','v','m','f')
           AND n.nspname NOT IN (${notSystem})
           AND has_column_privilege($1, c.oid, att.attname, 'UPDATE')`, role);
    const observedColumns = (columnUpdates || []).map((c) => `${c.rel}.${c.attname}`).sort();
    const expectedColumns = Object.entries(EXPECTED_COLUMN_UPDATE)
        .flatMap(([rel, cols]) => cols.map((col) => `${rel}.${col}`)).sort();
    if (JSON.stringify(observedColumns) !== JSON.stringify(expectedColumns)) {
        const extra = observedColumns.filter((c) => !expectedColumns.includes(c));
        const missing = expectedColumns.filter((c) => !observedColumns.includes(c));
        if (extra.length) problems.push(`role ${role} holds column UPDATE outside the allowlist: ${extra.join(', ')}`);
        if (missing.length) problems.push(`role ${role} lacks required column UPDATE: ${missing.join(', ')}`);
    }

    const explicitRoutines = await prisma.$queryRawUnsafe(`
        SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE a.grantee = ${roleOidSubquery()}
           AND p.proacl IS NOT NULL
           AND p.proowner <> ${roleOidSubquery()}
           AND n.nspname NOT IN (${notSystem})
         GROUP BY 1`, role, role);
    for (const r of explicitRoutines || []) {
        problems.push(`role ${role} holds an explicit routine privilege on ${r.signature}`);
    }

    const schemas = await prisma.$queryRawUnsafe(`
        SELECT n.nspname,
               has_schema_privilege($1, n.oid, 'USAGE')  AS usage,
               has_schema_privilege($1, n.oid, 'CREATE') AS create
          FROM pg_namespace n
         WHERE n.nspname NOT IN (${notSystem})`, role);
    for (const s of schemas || []) {
        if (s.create) problems.push(`role ${role} can CREATE in schema ${s.nspname}`);
        if (s.nspname === 'public' && !s.usage) problems.push(`role ${role} lacks USAGE on schema public`);
        if (s.nspname !== 'public' && s.usage) problems.push(`role ${role} has USAGE on schema ${s.nspname}`);
    }

    return {
        attributes: attrs,
        memberships: memberships || [],
        tablePrivileges: observed,
        columnUpdates: observedColumns,
        explicitRoutines: (explicitRoutines || []).map((r) => r.signature),
    };
}

/**
 * Bring an existing (possibly poisoned) function-owner role to the exact
 * least-privilege shape. Returns the measured catalog state.
 */
async function normaliseFunctionOwner(prisma, role, options = {}) {
    const applied = [];
    const problems = options.problems || [];
    await reconcileAttributes(prisma, role, applied);
    const revokedMemberships = await reconcileMemberships(prisma, role, applied);
    const revokedGrants = await revokeDirectPrivileges(prisma, role, applied);
    const ownership = await auditOwnership(prisma, role, problems);
    const revokedDefaultGrants = await revokeDefaultPrivileges(prisma, role, applied);
    return { applied, problems, revokedMemberships, revokedGrants, revokedDefaultGrants, ownership };
}

async function verifyFunctionOwner(prisma, role, problems) {
    const ownership = await auditOwnership(prisma, role, problems);
    const defaultAcl = await inspectDefaultPrivileges(prisma, role, problems);
    const verified = await verifyResult(prisma, role, problems);
    return { ...verified, ownership: ownership.owned, defaultAcl: defaultAcl.entries };
}

module.exports = {
    EXPECTED_TABLE_PRIVILEGES,
    EXPECTED_COLUMN_UPDATE,
    ALLOWED_OWNED_ROUTINE_PREFIX,
    isAllowedOwnedRoutine,
    normaliseFunctionOwner,
    verifyFunctionOwner,
    auditOwnership,
};
