// infra/install-authority-activation-function.js
// =============================================================================
// §WP-H — provision the SANCTIONED ACTIVATION PATH.
//
// The activation record is append-only and immutable, but writing it correctly
// also requires the latch, the flag, the GHS projection and the audit row. Those
// live in tables the operator role must not be able to touch, and the runtime
// role certainly must not. So the whole act becomes ONE database function owned
// by a dedicated NOLOGIN role that holds exactly those grants and nothing else.
//
// This installer is idempotent and corrects the older provisioning, where the
// operator held direct INSERT on the protected record (which let an operator
// append a record without the latch and projection, leaving the system in a
// half-activated state).
// =============================================================================
const fs = require('fs');
const path = require('path');

const TABLE = 'public."FiatLiquidityAuthorityActivation"';
const FN = 'public.azm_authority_activate(text,text,text,text,text)';
const FN_NAME = 'public.azm_authority_activate';

const DEFAULTS = {
    tableOwner: process.env.AUTHORITY_OWNER_ROLE || 'azm_authority_owner',
    functionOwner: process.env.AUTHORITY_FN_OWNER_ROLE || 'azm_authority_fn_owner',
    runtime: process.env.AUTHORITY_RUNTIME_ROLE || 'azm_app_runtime',
    operator: process.env.AUTHORITY_OPERATOR_ROLE || 'azm_authority_operator',
    migrator: process.env.AUTHORITY_MIGRATOR_ROLE || 'azm_migrator',
};

const quoteIdent = (name) => '"' + String(name).replace(/"/g, '""') + '"';

const { functionSql } = require("./lib/authority-function-sql");
const { resolveAuthorityRoles, assertDistinctRoles } = require("./lib/authority-roles");
const {
    normaliseFunctionOwner,
    verifyFunctionOwner,
} = require("./lib/authority-role-normalisation");

async function installAuthorityActivationFunction(prisma, options = {}) {
    const log = options.log || (() => {});
    // ONE resolver for every entry point (option > environment > canonical).
    const roles = resolveAuthorityRoles({
        owner: options.tableOwner || options.owner,
        runtime: options.runtime,
        operator: options.operator,
        functionOwner: options.functionOwner,
    });
    const { owner: tableOwner, runtime, operator, functionOwner } = roles;
    const roleScoped = options.roleScoped !== undefined
        ? options.roleScoped === true
        : Boolean(options.tableOwner || options.owner || options.operator || options.runtime || options.functionOwner);
    const report = {
        applied: [], problems: [], skipped: [], roles, functionOwner, operator,
        status: 'PROVISIONED', provisioned: true,
    };

    // BARE MODE RETURNS BEFORE ANY SIDE EFFECT: no role, no function, no grant,
    // no ownership change. A restore pass is not an authority installation and
    // must not be able to look like one.
    if (!roleScoped) {
        return {
            ...report,
            ok: true,
            status: 'SKIPPED_NOT_PROVISIONED',
            provisioned: false,
            skipped: ['bare overlay/restore invocation: no authority role, function or grant was created or altered'],
        };
    }

    try {
        assertDistinctRoles(roles);
    } catch (err) {
        report.problems.push(err.message);
        report.ok = false;
        report.status = 'REFUSED_ROLE_COLLISION';
        return report;
    }

    const roleExists = async (name) => {
        const [row] = await prisma.$queryRawUnsafe('SELECT 1 AS e FROM pg_roles WHERE rolname = $1', name);
        return !!row;
    };

    // 1. the dedicated function owner: no login, no role-creation, no inheritance
    if (!(await roleExists(functionOwner))) {
        await prisma.$executeRawUnsafe(
            `CREATE ROLE ${quoteIdent(functionOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
        report.applied.push(`create function owner ${functionOwner} (NOLOGIN)`);
        log(`created ${functionOwner} (NOLOGIN)`);
    } else {
        await prisma.$executeRawUnsafe(
            `ALTER ROLE ${quoteIdent(functionOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
        report.applied.push(`enforce function owner ${functionOwner} NOLOGIN`);
    }
    if (options.dryRun) return report;

    // BARE MODE. A bare overlay/restore invocation names no roles, so it has no
    // authority to bind a SECURITY DEFINER function to. Inferring a sanctioned
    // install from DEFAULT role names used to make the restore chain fail on a
    // clean database (the grant target did not exist yet). Skip, and say so.
    if (!roleScoped) {
        report.skipped.push('role-bound activation-function provisioning skipped: no roles were named');
        report.applied.push('bare overlay/restore invocation: function provisioning and grants not attempted');
        report.ok = report.problems.length === 0;
        return report;
    }

    // 2. NORMALISE THE OWNER, EXISTING OR NEW.
    // A pre-created role is the dangerous case: creating a narrow role when it
    // is absent says nothing about the role an attacker already installed. Every
    // attribute, every membership in either direction and every direct object
    // privilege is reconciled here, before the allowlist is applied, because
    // this function is SECURITY DEFINER and runs with the owner's privileges.
    const normalised = await normaliseFunctionOwner(prisma, functionOwner, { problems: report.problems });
    report.applied.push(...normalised.applied);
    report.normalisation = {
        revokedMemberships: normalised.revokedMemberships,
        revokedGrants: normalised.revokedGrants,
        // The whole audit result, not just the owned list: the refusals below
        // read `.unexpected` from it, and a flattened array made that check a
        // silent no-op.
        ownedObjects: normalised.ownership.owned,
        unexpectedOwnership: normalised.ownership.unexpected,
    };
    if (!(await roleExists(functionOwner))) report.problems.push('function owner role is missing');

    // STOP BEFORE INSTALLING. A role that failed its ownership audit must not own
    // a fresh SECURITY DEFINER function: installing first and reporting after
    // leaves a callable path behind a failed boundary. Nothing is reassigned —
    // stray objects may belong to a different system boundary.
    const unexpectedOwnership = normalised.ownership.unexpected || [];
    if (unexpectedOwnership.length > 0 || !(await roleExists(functionOwner))) {
        let revoked = 0;
        try {
            const [existing] = await prisma.$queryRawUnsafe(
                `SELECT to_regprocedure($1)::text AS fn`, FN);
            if (existing && existing.fn) {
                await prisma.$executeRawUnsafe(`REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC`);
                await prisma.$executeRawUnsafe(`REVOKE ALL ON FUNCTION ${FN} FROM ${quoteIdent(operator)}`);
                revoked = 1;
            }
        } catch (_) { /* the function may not exist; the refusal below still holds */ }
        report.status = unexpectedOwnership.length > 0 ? 'REFUSED_UNEXPECTED_OWNERSHIP' : 'REFUSED_ROLE_MISSING';
        report.skipped.push(
            unexpectedOwnership.length > 0
                ? `activation function NOT installed or replaced: ${functionOwner} owns unexpected object(s) ${unexpectedOwnership.map((o) => (typeof o === 'string' ? o : o.object || JSON.stringify(o))).join(', ')}`
                : 'activation function NOT installed or replaced: the function owner role is missing');
        if (revoked) report.applied.push('revoked EXECUTE on the existing activation function from PUBLIC and the operator');
        report.ok = false;
        return report;
    }

    // 3. the function, owned by the function owner, EXECUTE only for the operator
    await prisma.$executeRawUnsafe(functionSql(operator, functionOwner));
    report.applied.push(`install ${FN_NAME} owned by ${functionOwner}, EXECUTE -> ${operator}`);

    // 4. exactly the privileges the body needs, and no more
    // Only tables that exist are granted: a partially provisioned database must
    // still get a sound function, and the missing-table case is reported rather
    // than silently skipped.
    const tableGrants = [
        ['public."FiatLiquidityAuthorityActivation"', `GRANT SELECT ON TABLE ${TABLE} TO ${quoteIdent(functionOwner)}`],
        ['public."FiatLiquidityAuthorityActivation"', `GRANT INSERT ON TABLE ${TABLE} TO ${quoteIdent(functionOwner)}`],
        ['public."FiatLiquidityState"', `GRANT SELECT ON TABLE public."FiatLiquidityState" TO ${quoteIdent(functionOwner)}`],
        ['public."FiatLiquidityState"', `GRANT UPDATE ("authorityActivatedAt") ON TABLE public."FiatLiquidityState" TO ${quoteIdent(functionOwner)}`],
        ['public."GlobalSettings"', `GRANT SELECT ON TABLE public."GlobalSettings" TO ${quoteIdent(functionOwner)}`],
        ['public."GlobalSettings"', `GRANT UPDATE ("fiatLiquidityAuthorityEnabled") ON TABLE public."GlobalSettings" TO ${quoteIdent(functionOwner)}`],
        ['public."SystemFiatPool"', `GRANT SELECT, UPDATE ("balance") ON TABLE public."SystemFiatPool" TO ${quoteIdent(functionOwner)}`],
        ['public."Withdrawal"', `GRANT SELECT ON TABLE public."Withdrawal" TO ${quoteIdent(functionOwner)}`],
        ['public."TransactionHistory"', `GRANT SELECT ON TABLE public."TransactionHistory" TO ${quoteIdent(functionOwner)}`],
        ['public."FiatLiquidityReservation"', `GRANT SELECT ON TABLE public."FiatLiquidityReservation" TO ${quoteIdent(functionOwner)}`],
        ['public."AdminSettingsAuditLog"', `GRANT INSERT ON TABLE public."AdminSettingsAuditLog" TO ${quoteIdent(functionOwner)}`],
    ];
    report.skipped = [];
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(functionOwner)}`);
    for (const [qualified, statement] of tableGrants) {
        try {
            await prisma.$executeRawUnsafe(statement);
        } catch (err) {
            // A partially provisioned database (a minimal test schema, a fresh
            // install) must still get a sound function; the absence is reported.
            const detail = qualified + ': ' + String(err.message).split(String.fromCharCode(10))[0];
            if (roleScoped) report.problems.push(detail); else report.skipped.push(detail);
        }
    }
    if (report.skipped.length) report.applied.push(`skipped grants for absent tables: ${report.skipped.join(', ')}`);
    report.applied.push('granted function-owner the minimum column-level privileges');

    // 5. the operator no longer writes the record itself
    await prisma.$executeRawUnsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE ${TABLE} FROM ${quoteIdent(operator)}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE ${TABLE} TO ${quoteIdent(operator)}`);
    report.applied.push(`revoked direct INSERT on the activation record from ${operator}`);

    // 6. verify from the catalog, not from the statements we just ran
    const [fnRow] = await prisma.$queryRawUnsafe(`
        SELECT p.prosecdef AS security_definer, p.proconfig AS config, r.rolname AS owner, r.rolcanlogin AS owner_can_login
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.oid = $1::regprocedure`, FN);
    if (!fnRow) report.problems.push('activation function is missing');
    else {
        if (!fnRow.security_definer) report.problems.push('activation function is not SECURITY DEFINER');
        if (fnRow.owner !== functionOwner) report.problems.push(`activation function owner is ${fnRow.owner}, expected ${functionOwner}`);
        if (fnRow.owner_can_login) report.problems.push('activation function owner can log in');
        const cfg = Array.isArray(fnRow.config) ? fnRow.config.join(',') : '';
        if (!/search_path=pg_catalog/.test(cfg.replace(/\s+/g, ''))) report.problems.push('activation function does not pin search_path to pg_catalog');
    }
    const [acl] = await prisma.$queryRawUnsafe(
        `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS op,
                has_function_privilege($3, $2::regprocedure, 'EXECUTE') AS rt,
                has_function_privilege('public', $2::regprocedure, 'EXECUTE') AS pub`,
        operator, FN, runtime);
    if (acl && !acl.op) report.problems.push('operator cannot EXECUTE the activation function');
    if (acl && acl.rt) report.problems.push('runtime can EXECUTE the activation function');
    if (acl && acl.pub) report.problems.push('PUBLIC can EXECUTE the activation function');

    const [opInsert] = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1, $2, 'INSERT') AS can_insert`, operator, TABLE);
    if (opInsert && opInsert.can_insert) report.problems.push('operator still holds direct INSERT on the activation record');

    // 7. VERIFY THE RESULTING CATALOG STATE, not the statements we ran.
    // Role-scoped installs fail on any gap. A bare overlay run is a schema
    // restore, not an authority install: its gaps are reported as skips, and it
    // still never claims a verified boundary.
    const verifySink = roleScoped ? report.problems : report.skipped;
    const verification = await verifyFunctionOwner(prisma, functionOwner, verifySink);
    report.verification = {
        attributes: verification.attributes,
        memberships: verification.memberships,
        tablePrivileges: verification.tablePrivileges,
        columnUpdates: verification.columnUpdates,
        explicitRoutines: verification.explicitRoutines,
        ownedObjects: verification.ownership,
    };

    report.ok = report.problems.length === 0;
    return report;
}

module.exports = { installAuthorityActivationFunction, DEFAULTS, FN, TABLE };

if (require.main === module) {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    installAuthorityActivationFunction(prisma, { log: (l) => console.log(`[authority-activation-fn] ${l}`) })
        .then((report) => {
            console.log(JSON.stringify({ ok: report.ok, problems: report.problems, applied: report.applied }, null, 2));
            if (!report.ok) process.exitCode = 1;
        })
        .catch((err) => { console.error(`[authority-activation-fn] FAILED: ${err.message}`); process.exitCode = 1; })
        .finally(async () => { await prisma.$disconnect(); });
}
