#!/usr/bin/env node
'use strict';

/**
 * WP-I — database-enforced witness provenance (activation installer).
 *
 * Applies the grants that make a settlement witness un-authorable by the
 * runtime database identity. Idempotent and fail-closed: it refuses to run
 * unless both role names are supplied, because silently succeeding without a
 * runtime role would leave the forgery open while reporting success.
 *
 * Two hardening rules this installer follows:
 *   1. A role name is an IDENTIFIER, not a value. It is validated against a
 *      conservative pattern and then quoted, so a name can never smuggle SQL.
 *   2. Grants are PROVEN, not trusted. Every check afterwards asks PostgreSQL
 *      what the role can EFFECTIVELY do (has_table_privilege includes PUBLIC and
 *      inherited authority), because a requested GRANT is not evidence that the
 *      authority is limited.
 *
 * WHY THIS IS NOT infra/install-*.js: that directory is the schema-overlay
 * battery, whose contract is that every installer exits 0 given only
 * DATABASE_URL (r38-overlay-upgrade-path asserts it). This script needs two
 * role names and must refuse without them, so living there would either break
 * that battery or force a dishonest silent skip. It is an activation step, not
 * an overlay. The TABLE itself is created by
 * infra/install-wp-i-settlement-witness.js in the release chain.
 *
 * NOT run automatically. Invoke explicitly:
 *   AZM_WITNESS_RUNTIME_ROLE=<app db role> \
 *   AZM_WITNESS_RECONCILER_ROLE=<reconciler db role> \
 *   node infra/wp-i/install-witness-provenance.js
 */

const { PrismaClient } = require('@prisma/client');

const RUNTIME = process.env.AZM_WITNESS_RUNTIME_ROLE;
const RECONCILER = process.env.AZM_WITNESS_RECONCILER_ROLE;

// PostgreSQL identifiers: start with a letter or underscore, then letters,
// digits, underscore or dollar. Deliberately narrower than PostgreSQL allows —
// the owner's roles never need anything exotic, so anything else is refused
// rather than escaped.
const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function quoteIdent(name) {
    if (typeof name !== 'string' || !ROLE_PATTERN.test(name)) {
        throw new Error(`[wp-i] refusing to use ${JSON.stringify(name)} as a role identifier`);
    }
    return `"${name}"`;
}

// has_table_privilege resolves its table argument like an unquoted identifier,
// so a mixed-case table name must arrive QUOTED or PostgreSQL folds it to
// lowercase and reports the table as missing.
function quoteTable(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

async function effective(prisma, role, table, privilege) {
    const rows = await prisma.$queryRawUnsafe(
        'SELECT has_table_privilege($1, $2, $3) AS ok', role, quoteTable(table), privilege
    );
    return rows[0].ok === true;
}

async function main() {
    if (!RUNTIME || !RECONCILER) {
        console.error(
            '[wp-i] refusing to run: set AZM_WITNESS_RUNTIME_ROLE and AZM_WITNESS_RECONCILER_ROLE.\n'
            + '       Without them the witness table stays writable by the runtime identity.'
        );
        process.exit(1);
    }
    if (RUNTIME === RECONCILER) {
        console.error('[wp-i] refusing to run: runtime and reconciler must be DIFFERENT roles.');
        process.exit(1);
    }

    let Q_RUNTIME;
    let Q_RECONCILER;
    try {
        Q_RUNTIME = quoteIdent(RUNTIME);
        Q_RECONCILER = quoteIdent(RECONCILER);
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }

    const prisma = new PrismaClient();
    try {
        const exists = await prisma.$queryRawUnsafe(
            'SELECT rolname FROM pg_roles WHERE rolname IN ($1, $2)', RUNTIME, RECONCILER
        );
        const found = new Set(exists.map((r) => r.rolname));
        for (const role of [RUNTIME, RECONCILER]) {
            if (!found.has(role)) {
                console.error(`[wp-i] refusing to run: role ${role} does not exist. Create it first.`);
                process.exit(1);
            }
        }

        // The witness writer claims the provider observation in the SAME
        // transaction as the witness row (one observation, one economic use),
        // so the claim table must exist before the reconciler can be granted.
        const claimTable = await prisma.$queryRawUnsafe('SELECT to_regclass($1)::text AS oid', 'public."ProviderObservationClaim"');
        if (claimTable[0].oid === null) {
            console.error('[wp-i] refusing to run: ProviderObservationClaim does not exist. Run infra/install-provider-observation-claim.js first.');
            process.exit(1);
        }

        const statements = [
            // Nobody gets the table by default, including PUBLIC.
            'REVOKE ALL ON "ProviderSettlementWitness" FROM PUBLIC',
            // The runtime may READ evidence. It may never author it.
            `REVOKE ALL ON "ProviderSettlementWitness" FROM ${Q_RUNTIME}`,
            `GRANT USAGE ON SCHEMA public TO ${Q_RUNTIME}`,
            `GRANT SELECT ON "ProviderSettlementWitness" TO ${Q_RUNTIME}`,
            // The reconciler may APPEND. It may never rewrite history.
            `REVOKE ALL ON "ProviderSettlementWitness" FROM ${Q_RECONCILER}`,
            `GRANT USAGE ON SCHEMA public TO ${Q_RECONCILER}`,
            `GRANT SELECT, INSERT ON "ProviderSettlementWitness" TO ${Q_RECONCILER}`,
            // It must also READ the opening it is witnessing. Without this the
            // reconciler cannot validate the receipt and the whole witness step
            // fails at runtime with a permission error.
            `REVOKE ALL ON "FiatLiquidityReceipt" FROM ${Q_RECONCILER}`,
            `GRANT SELECT ON "FiatLiquidityReceipt" TO ${Q_RECONCILER}`,
            // The witness transaction also INSERTs the observation claim and
            // SELECTs a conflicting holder (providerObservationClaimService).
            // Without these the first witness attempt fails with a permission
            // error. Append and read only: a claim is never rewritten or
            // released by the reconciler.
            `REVOKE ALL ON "ProviderObservationClaim" FROM ${Q_RECONCILER}`,
            `GRANT SELECT, INSERT ON "ProviderObservationClaim" TO ${Q_RECONCILER}`,
            // Promotion is the runtime's job under its own authority checks. The
            // reconciler proves a payment happened; it never moves money state.
            `REVOKE ALL ON "FiatLiquidityState" FROM ${Q_RECONCILER}`,
            `REVOKE ALL ON "SystemFiatPool" FROM ${Q_RECONCILER}`,
        ];
        for (const sql of statements) {
            await prisma.$executeRawUnsafe(sql);
            console.log(`[wp-i] ok: ${sql}`);
        }

        // ── Prove it, do not trust it ────────────────────────────────────────
        const failures = [];
        const expect = async (role, table, privilege, wanted) => {
            const ok = await effective(prisma, role, table, privilege);
            if (ok !== wanted) {
                failures.push(`${role} ${wanted ? 'cannot' : 'can still'} ${privilege} on ${table}`);
            }
        };

        await expect(RUNTIME, 'ProviderSettlementWitness', 'SELECT', true);
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
            await expect(RUNTIME, 'ProviderSettlementWitness', p, false);
        }
        await expect(RECONCILER, 'ProviderSettlementWitness', 'SELECT', true);
        await expect(RECONCILER, 'ProviderSettlementWitness', 'INSERT', true);
        for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) {
            await expect(RECONCILER, 'ProviderSettlementWitness', p, false);
        }
        await expect(RECONCILER, 'FiatLiquidityReceipt', 'SELECT', true);
        for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
            await expect(RECONCILER, 'FiatLiquidityReceipt', p, false);
        }
        await expect(RECONCILER, 'ProviderObservationClaim', 'SELECT', true);
        await expect(RECONCILER, 'ProviderObservationClaim', 'INSERT', true);
        for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) {
            await expect(RECONCILER, 'ProviderObservationClaim', p, false);
        }
        // These two exist in any database the release chain has touched. If one
        // is absent this is not the financial schema at all, and asserting on it
        // would fail for the wrong reason — so the absence is reported, not
        // silently treated as a pass.
        for (const table of ['FiatLiquidityState', 'SystemFiatPool']) {
            const present = await prisma.$queryRawUnsafe('SELECT to_regclass($1)::text AS oid', `public."${table}"`);
            if (present[0].oid === null) {
                console.warn(`[wp-i] note: ${table} is absent, skipping its privilege proof`);
                continue;
            }
            for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
                await expect(RECONCILER, table, p, false);
            }
        }
        // PUBLIC must hold nothing: a default grant would hand the table to every login.
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
            const ok = await prisma.$queryRawUnsafe(
                'SELECT has_table_privilege($1, $2, $3) AS ok', 'public', quoteTable('ProviderSettlementWitness'), p
            );
            if (ok[0].ok === true) failures.push(`PUBLIC can ${p} on ProviderSettlementWitness`);
        }
        // Neither identity may become the other: no membership either direction.
        for (const [a, b] of [[RUNTIME, RECONCILER], [RECONCILER, RUNTIME]]) {
            const rows = await prisma.$queryRawUnsafe(
                'SELECT pg_has_role($1, $2, $3) AS member', a, b, 'MEMBER'
            );
            if (rows[0].member === true) failures.push(`${a} inherits ${b}`);
        }

        if (failures.length > 0) {
            console.error('[wp-i] FAILED:');
            for (const f of failures) console.error(`  - ${f}`);
            process.exit(1);
        }

        const rows = await prisma.$queryRawUnsafe(
            `SELECT grantee, privilege_type FROM information_schema.role_table_grants
              WHERE table_name = 'ProviderSettlementWitness'
                AND grantee IN ($1, $2) ORDER BY grantee, privilege_type`,
            RUNTIME, RECONCILER
        );
        console.log('[wp-i] effective grants:', JSON.stringify(rows));
        console.log('[wp-i] provenance installed and proven. Treasury activation still requires the witness writer.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => {
    console.error('[wp-i] installer failed:', e.message);
    process.exit(1);
});
