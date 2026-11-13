#!/usr/bin/env node
// infra/install-authority-activation-roles.js
// =============================================================================
// §WP-E — ESTABLISH THE DATABASE-ENFORCED AUTHORITY BOUNDARY.
//
// This is a CONTROLLED PROVISIONING step, run by whoever controls the database
// (a DBA or the deployment's migration authority). It is deliberately NOT
// reachable from the application: no route, no service call, no job. The
// runtime can never provision its own authority boundary, because doing so
// would make the boundary a runtime decision.
//
//   node infra/install-authority-activation-roles.js \
//     --owner azm_authority_owner \
//     --runtime azm_app_runtime \
//     --operator azm_authority_operator \
//     [--dry-run]
//
// Requires: permission to CREATE ROLE, and ownership of the activation table
// (i.e. run it as the migration owner, or as a superuser).
//
// WHAT IT PROVES AT THE END (and fails on, rather than reporting success):
//   • the owner role is distinct from the runtime role;
//   • the runtime role is not a member of the owner or operator role;
//   • the operator role is not a member of the runtime role;
//   • the runtime role has SELECT and no INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER;
//   • the operator role has SELECT+INSERT and no UPDATE/DELETE/TRUNCATE;
//   • the owner role is NOLOGIN, so no connection can authenticate as it.
// =============================================================================
'use strict';

const path = require('path');

const DEFAULTS = {
    owner: 'azm_authority_owner',
    runtime: 'azm_app_runtime',
    operator: 'azm_authority_operator',
};

const TABLE = 'public."FiatLiquidityAuthorityActivation"';
const TRIGGER_FN = 'public.azm_authority_activation_immutable()';

function quoteIdent(name) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) throw new Error(`unsafe role name: ${name}`);
    return `"${name}"`;
}


/**
 * Prisma raw execution cannot send several statements in one round trip, and
 * the shipped migration contains a dollar-quoted function body. Split on
 * top-level semicolons only.
 */
function splitSqlStatements(sql) {
    // Strip line comments first (outside dollar-quoted bodies), so a pure
    // comment block never becomes an "empty" statement.
    let cleaned = '';
    let inDollarComment = false;
    let inComment = false;
    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (inComment) {
            if (ch === '\n') { inComment = false; cleaned += ch; }
            continue;
        }
        if (!inDollarComment && ch === '-' && next === '-') { inComment = true; i += 1; continue; }
        if (ch === '$' && next === '$') {
            inDollarComment = !inDollarComment;
            cleaned += '$$';
            i += 1;
            continue;
        }
        cleaned += ch;
    }

    const statements = [];
    let current = '';
    let inDollar = false;
    for (let i = 0; i < cleaned.length; i += 1) {
        const ch = cleaned[i];
        const next = cleaned[i + 1];
        if (ch === '$' && next === '$') {
            inDollar = !inDollar;
            current += '$$';
            i += 1;
            continue;
        }
        if (ch === ';' && !inDollar) {
            const trimmed = current.trim();
            if (trimmed.length > 0) statements.push(trimmed);
            current = '';
            continue;
        }
        current += ch;
    }
    const trailing = current.trim();
    if (trailing.length > 0) statements.push(trailing);
    return statements;
}

async function applyMigrationSql(prisma, sql) {
    for (const statement of splitSqlStatements(sql)) {
        await prisma.$executeRawUnsafe(statement);
    }
}

async function roleExists(prisma, name) {
    const rows = await prisma.$queryRawUnsafe('SELECT 1 AS ok FROM pg_roles WHERE rolname = $1', name);
    return rows.length > 0;
}

// The OWNER is created NOLOGIN on purpose: no connection may authenticate as
// the role that owns the append-only record. The runtime and operator roles must
// be able to authenticate, so they are created LOGIN — with NO password, which
// the deployment's credential authority sets separately. This script never
// invents or stores a secret.
async function ensureRole(prisma, name, { login }) {
    const existing = await roleExists(prisma, name);
    if (existing) return { name, created: false };
    await prisma.$executeRawUnsafe(
        `CREATE ROLE ${quoteIdent(name)} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
    );
    return { name, created: true };
}

async function privilege(prisma, role, what) {
    const [row] = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1, '${TABLE}', $2) AS granted`, role, what
    );
    return row && row.granted === true;
}

async function installAuthorityActivationRoles(prisma, options = {}) {
    const owner = options.owner || DEFAULTS.owner;
    const runtime = options.runtime || DEFAULTS.runtime;
    const operator = options.operator || DEFAULTS.operator;
    const dryRun = options.dryRun === true;
    const log = options.log || (() => {});

    const report = { roles: [], applied: [], problems: [], ok: false };

    // ── preflight: the whole design is void if these names collide ───────────
    if (new Set([owner, runtime, operator]).size !== 3) {
        throw new Error('owner, runtime and operator must be three distinct roles');
    }
    const [superuser] = await prisma.$queryRawUnsafe(
        `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`
    );
    const [ownerPriv] = await prisma.$queryRawUnsafe(
        `SELECT (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS can_create_role`
    );
    if (dryRun) {
        log(`[dry-run] would create ${owner} (NOLOGIN), ${runtime}, ${operator} and re-parent ${TABLE}`);
        return { ...report, ok: true, dryRun: true };
    }

    // ── roles ───────────────────────────────────────────────────────────────
    for (const name of [owner, runtime, operator]) {
        const result = await ensureRole(prisma, name, { login: name !== owner });
        report.roles.push(result);
        log(`role ${name}: ${result.created ? 'created' : 'already present'}`);
    }

    // The owner must be non-login: no connection may authenticate as it.
    await prisma.$executeRawUnsafe(`ALTER ROLE ${quoteIdent(owner)} NOLOGIN NOCREATEROLE NOSUPERUSER`);
    report.applied.push(`ALTER ROLE ${owner} NOLOGIN`);

    // ── the append-only record (idempotent DDL, same file the migration ships) */
    const fs = require('fs');
    const migrationSql = fs.readFileSync(
        path.join(__dirname, '..', 'prisma', 'migrations',
            '20261110230000_p5d_enforced_authority_activation', 'migration.sql'),
        'utf8'
    );
    await applyMigrationSql(prisma, migrationSql);
    report.applied.push('migration 20261110230000_p5d_enforced_authority_activation');

    // ── ownership separation: the runtime must never own the record ─────────
    await prisma.$executeRawUnsafe(`ALTER TABLE ${TABLE} OWNER TO ${quoteIdent(owner)}`);
    await prisma.$executeRawUnsafe(`ALTER FUNCTION ${TRIGGER_FN} OWNER TO ${quoteIdent(owner)}`);
    report.applied.push(`ALTER TABLE/FUNCTION OWNER TO ${owner}`);

    // ── privileges: least privilege, granted explicitly ─────────────────────
    const grants = [
        `REVOKE ALL ON TABLE ${TABLE} FROM PUBLIC`,
        `REVOKE ALL ON TABLE ${TABLE} FROM ${quoteIdent(runtime)}`,
        `REVOKE ALL ON TABLE ${TABLE} FROM ${quoteIdent(operator)}`,
        `GRANT SELECT ON TABLE ${TABLE} TO ${quoteIdent(runtime)}`,
        `GRANT SELECT ON TABLE ${TABLE} TO ${quoteIdent(operator)}`,
        `GRANT USAGE ON SCHEMA public TO ${quoteIdent(runtime)}`,
        `GRANT USAGE ON SCHEMA public TO ${quoteIdent(operator)}`,
    ];
    for (const statement of grants) {
        await prisma.$executeRawUnsafe(statement);
        report.applied.push(statement);
    }

    // Nothing in this deployment may inherit into the activation role.
    for (const member of [runtime, operator]) {
        if (await membership(prisma, member, owner)) {
            await prisma.$executeRawUnsafe(`REVOKE ${quoteIdent(owner)} FROM ${quoteIdent(member)}`);
            report.applied.push(`REVOKE ${owner} FROM ${member}`);
        }
        if (await membership(prisma, member, operator)) {
            await prisma.$executeRawUnsafe(`REVOKE ${quoteIdent(operator)} FROM ${quoteIdent(member)}`);
            report.applied.push(`REVOKE ${operator} FROM ${member}`);
        }
    }

    // ── verify, then fail loudly ────────────────────────────────────────────
    // §WP-H: the operator no longer inserts the record itself; the sanctioned
    // path is the SECURITY DEFINER function owned by the dedicated NOLOGIN role.
    // A bare overlay run (no role context) must not attempt role-scoped
    // provisioning: it has no owner/operator credential to bind the function to.
    // Role context means the caller EXPLICITLY named roles: the sanctioned
    // procedure. A bare overlay run (npm release, CI restore) takes the defaults
    // from the environment and is a SCHEMA RESTORE, not an authority install, so
    // a table that does not exist yet is a skip there and a hard problem when the
    // roles were named.
    const explicitRoles = process.argv.slice(2).some((a) => /^--(owner|runtime|operator|function-owner)\b/.test(a));
    const hasRoleContext = explicitRoles
        || (typeof options !== 'undefined' && options
            && (options.roleScoped === true || options.owner || options.runtime || options.operator));
    const { installAuthorityActivationFunction } = require('./install-authority-activation-function');
    // A database without the activation table (a bare overlay run, a first
    // install) cannot host the function yet: record it, never abort the roles
    // install, and never let the absence read as success.
    let fnReport = null;
    if (hasRoleContext) try {
    fnReport = await installAuthorityActivationFunction(prisma, {
        tableOwner: owner,
        functionOwner: (typeof options !== 'undefined' && options.functionOwner) || process.env.AUTHORITY_FN_OWNER_ROLE || `${owner}_fn`,
        runtime,
        operator,
        log,
        dryRun: (typeof options !== 'undefined' ? options.dryRun : false) === true,
        roleScoped: hasRoleContext,
    });
    } catch (fnErr) {
        fnReport = { ok: false, skipped: [String(fnErr.message).slice(0, 240)] };
        report.skipped = (report.skipped || []).concat(['activation function: ' + fnReport.skipped[0]]);
    }
    if (fnReport && fnReport.problems) report.problems = (report.problems || []).concat(fnReport.problems);
    report.functionInstall = fnReport;

    const runtimePrivs = {
        select: await privilege(prisma, runtime, 'SELECT'),
        insert: await privilege(prisma, runtime, 'INSERT'),
        update: await privilege(prisma, runtime, 'UPDATE'),
        delete: await privilege(prisma, runtime, 'DELETE'),
        truncate: await privilege(prisma, runtime, 'TRUNCATE'),
        trigger: await privilege(prisma, runtime, 'TRIGGER'),
    };
    const operatorPrivs = {
        select: await privilege(prisma, operator, 'SELECT'),
        insert: await privilege(prisma, operator, 'INSERT'),
        update: await privilege(prisma, operator, 'UPDATE'),
        delete: await privilege(prisma, operator, 'DELETE'),
        truncate: await privilege(prisma, operator, 'TRUNCATE'),
    };
    report.privileges = { runtime: runtimePrivs, operator: operatorPrivs };

    if (!runtimePrivs.select) report.problems.push('runtime role cannot SELECT the activation record');
    for (const forbidden of ['insert', 'update', 'delete', 'truncate', 'trigger']) {
        if (runtimePrivs[forbidden]) report.problems.push(`runtime role still holds ${forbidden.toUpperCase()}`);
    }
    // Only a role-scoped run (the sanctioned procedure) can revoke the legacy
    // direct INSERT; a bare overlay run has no role context and must not fail
    // for a grant it was never asked to change.
    if (hasRoleContext && operatorPrivs.insert) report.problems.push('operator role still holds direct INSERT on the activation record');
    for (const forbidden of ['update', 'delete', 'truncate']) {
        if (operatorPrivs[forbidden]) report.problems.push(`operator role still holds ${forbidden.toUpperCase()}`);
    }
    if (await membership(prisma, runtime, owner)) report.problems.push('runtime role is a member of the owner role');
    if (await membership(prisma, owner, runtime)) report.problems.push('owner role is a member of the runtime role');

    const [ownerRow] = await prisma.$queryRawUnsafe(
        `SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1`, owner
    );
    if (ownerRow && ownerRow.rolcanlogin) report.problems.push('owner role can log in');
    if (ownerRow && ownerRow.rolsuper) report.problems.push('owner role is a superuser');

    if (hasRoleContext && fnReport && Array.isArray(fnReport.problems)) report.problems.push(...fnReport.problems);
    report.ok = report.problems.length === 0;
    report.applicable = {
        superuser: superuser && superuser.is_superuser === true,
        canCreateRole: ownerPriv && ownerPriv.can_create_role === true,
    };
    return report;
}

async function membership(prisma, member, role) {
    const [row] = await prisma.$queryRawUnsafe(
        `SELECT pg_has_role($1, $2, 'MEMBER') AS member`, member, role
    );
    return row && row.member === true;
}

module.exports = { installAuthorityActivationRoles, splitSqlStatements, DEFAULTS };

if (require.main === module) {
    const args = process.argv.slice(2);
    const get = (flag, fallback) => {
        const i = args.indexOf(flag);
        return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
    };
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    // Only EXPLICITLY named roles are passed: an unnamed invocation is a schema
    // restore (npm release, CI overlay pass) and must not be mistaken for the
    // sanctioned role-scoped install. Defaults are filled inside the installer.
    const named = {};
    if (args.includes('--owner')) named.owner = get('--owner', null);
    if (args.includes('--runtime')) named.runtime = get('--runtime', null);
    if (args.includes('--operator')) named.operator = get('--operator', null);
    if (Object.keys(named).length > 0) named.roleScoped = true;
    installAuthorityActivationRoles(prisma, {
        ...named,
        dryRun: args.includes('--dry-run'),
        log: (line) => console.log(`[authority-roles] ${line}`),
    })
        .then((report) => {
            console.log(JSON.stringify({ ok: report.ok, problems: report.problems, privileges: report.privileges }, null, 2));
            if (!report.ok) process.exitCode = 1;
        })
        .catch((err) => {
            console.error(`[authority-roles] FAILED: ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => { await prisma.$disconnect(); });
}
