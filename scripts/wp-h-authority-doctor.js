#!/usr/bin/env node
// scripts/wp-h-authority-doctor.js
// =============================================================================
// §WP-H — READ-ONLY diagnosis of the authority boundary. It provisions nothing,
// grants nothing and changes nothing: it reports what the live database looks
// like so a DBA can see exactly what the connection split still needs.
//
// Usage: node scripts/wp-h-authority-doctor.js   (uses DATABASE_URL)
//        exit 0 = healthy or diagnosable, exit 1 = --strict and not enforceable
// =============================================================================
'use strict';
const { PrismaClient } = require('@prisma/client');

const TABLE = 'FiatLiquidityAuthorityActivation';
const FN = 'public.azm_authority_activate(text,text,text,text,text)';

async function main() {
    const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    const findings = [];
    const rows = [];
    try {
        const [id] = await prisma.$queryRawUnsafe(`
            SELECT current_user AS session_role,
                   (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
                   to_regclass('public."${TABLE}"') IS NOT NULL AS table_exists`);
        rows.push(['connected as', id.session_role]);
        rows.push(['superuser', String(id.is_superuser)]);

        if (id.is_superuser) findings.push('runtime connects as a SUPERUSER: no boundary can be proven from here');

        if (!id.table_exists) {
            findings.push(`protected table public."${TABLE}" does not exist (the roles installer has not run)`);
        } else {
            const [own] = await prisma.$queryRawUnsafe(`
                SELECT pg_get_userbyid(c.relowner) AS owner,
                       (SELECT rolcanlogin FROM pg_roles WHERE oid = c.relowner) AS owner_can_login
                  FROM pg_class c WHERE c.oid = to_regclass('public."${TABLE}"')`);
            rows.push(['table owner', own.owner]);
            rows.push(['table owner can log in', String(own.owner_can_login)]);
            if (own.owner === id.session_role) {
                findings.push(`runtime IS the table owner (${own.owner}): split release from runtime before enforcing`);
            }
            if (own.owner_can_login) findings.push(`table owner ${own.owner} can log in`);
        }

        const [fn] = await prisma.$queryRawUnsafe(`
            SELECT p.prosecdef AS secdef, p.proconfig AS cfg, pg_get_userbyid(p.proowner) AS owner
              FROM pg_proc p WHERE p.oid = to_regprocedure('${FN}')`).catch(() => [null]);
        if (!fn) {
            findings.push(`activation function ${FN} does not exist (the function installer has not run)`);
        } else {
            rows.push(['function owner', fn.owner]);
            rows.push(['SECURITY DEFINER', String(fn.secdef)]);
            rows.push(['search_path', Array.isArray(fn.cfg) ? fn.cfg.join(',') : '(unset)']);
            if (!fn.secdef) findings.push('activation function is not SECURITY DEFINER');
            if (fn.owner === id.session_role) findings.push(`runtime IS the function owner (${fn.owner})`);
        }

        const [legacy] = await prisma.$queryRawUnsafe(`
            SELECT has_table_privilege(current_user, 'public."GlobalSettings"', 'SELECT') AS gs,
                   has_table_privilege(current_user, 'public."FiatLiquidityState"', 'SELECT') AS fls`)
            .catch(() => [null]);
        if (legacy) {
            rows.push(['can read legacy latch tables', `GlobalSettings=${legacy.gs} FiatLiquidityState=${legacy.fls}`]);
            if (!legacy.gs || !legacy.fls) {
                findings.push('runtime cannot read the legacy latch tables: every authority read will be LEGACY_UNREADABLE');
            }
        }
    } finally {
        await prisma.$disconnect();
    }

    console.log('WP-H authority doctor (read-only)\n');
    for (const [k, v] of rows) console.log(`  ${k.padEnd(32)} ${v}`);
    console.log('');
    if (findings.length === 0) {
        console.log('  No blockers found. The boundary can be attested from this connection.');
    } else {
        console.log(`  ${findings.length} blocker(s):`);
        for (const f of findings) console.log(`   - ${f}`);
        console.log('\n  Nothing was changed. Provisioning and the release/runtime split are DBA actions.');
    }
    if (process.argv.includes('--strict') && findings.length > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('doctor failed:', err.message);
    process.exitCode = 1;
});
