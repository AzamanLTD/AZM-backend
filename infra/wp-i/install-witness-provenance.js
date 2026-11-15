#!/usr/bin/env node
'use strict';

/**
 * WP-I — database-enforced witness provenance (deployment installer).
 *
 * Applies the grants that make a settlement witness un-authorable by the
 * runtime database identity. Idempotent and fail-closed: it refuses to run
 * unless both role names are supplied, because silently succeeding without a
 * runtime role would leave the forgery open while reporting success.
 *
 * WHY THIS IS NOT infra/install-*.js: that directory is the schema-overlay
 * battery, whose contract is that every installer exits 0 given only
 * DATABASE_URL (r38-overlay-upgrade-path asserts it). This script needs two
 * role names and must refuse without them, so living there would either break
 * that battery or force a dishonest silent skip. It is an activation step, not
 * an overlay.
 *
 * NOT run automatically. Invoke explicitly:
 *   AZM_WITNESS_RUNTIME_ROLE=<app db role> \
 *   AZM_WITNESS_RECONCILER_ROLE=<reconciler db role> \
 *   node infra/wp-i/install-witness-provenance.js
 */

const { PrismaClient } = require('@prisma/client');

const RUNTIME = process.env.AZM_WITNESS_RUNTIME_ROLE;
const RECONCILER = process.env.AZM_WITNESS_RECONCILER_ROLE;

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

    const prisma = new PrismaClient();
    try {
        const exists = await prisma.$queryRawUnsafe(
            `SELECT rolname FROM pg_roles WHERE rolname IN ($1, $2)`, RUNTIME, RECONCILER
        );
        const found = new Set(exists.map((r) => r.rolname));
        for (const role of [RUNTIME, RECONCILER]) {
            if (!found.has(role)) {
                console.error(`[wp-i] refusing to run: role ${role} does not exist. Create it first.`);
                process.exit(1);
            }
        }

        const statements = [
            // Nobody gets the table by default.
            `REVOKE ALL ON "ProviderSettlementWitness" FROM PUBLIC`,
            // The runtime may READ evidence. It may never author it.
            `REVOKE ALL ON "ProviderSettlementWitness" FROM ${RUNTIME}`,
            `GRANT USAGE ON SCHEMA public TO ${RUNTIME}`,
            `GRANT SELECT ON "ProviderSettlementWitness" TO ${RUNTIME}`,
            // The reconciler may APPEND. It may never rewrite history.
            `REVOKE ALL ON "ProviderSettlementWitness" FROM ${RECONCILER}`,
            `GRANT USAGE ON SCHEMA public TO ${RECONCILER}`,
            `GRANT SELECT, INSERT ON "ProviderSettlementWitness" TO ${RECONCILER}`,
            // It must also READ the opening it is witnessing. Without this the
            // reconciler cannot validate the receipt and the whole witness step
            // fails at runtime with a permission error.
            `REVOKE ALL ON "FiatLiquidityReceipt" FROM ${RECONCILER}`,
            `GRANT SELECT ON "FiatLiquidityReceipt" TO ${RECONCILER}`,
        ];
        for (const sql of statements) {
            await prisma.$executeRawUnsafe(sql);
            console.log(`[wp-i] ok: ${sql}`);
        }

        const rows = await prisma.$queryRawUnsafe(
            `SELECT grantee, privilege_type FROM information_schema.role_table_grants
              WHERE table_name = 'ProviderSettlementWitness'
                AND grantee IN ($1, $2) ORDER BY grantee, privilege_type`,
            RUNTIME, RECONCILER
        );
        console.log('[wp-i] effective grants:', JSON.stringify(rows));

        // Verify the opening read grant actually landed, rather than trusting the list.
        const receipt = await prisma.$queryRawUnsafe(
            `SELECT grantee, privilege_type FROM information_schema.role_table_grants
              WHERE table_name = 'FiatLiquidityReceipt' AND grantee = $1`, RECONCILER
        );
        if (!receipt.some((r) => r.privilege_type === 'SELECT')) {
            console.error('[wp-i] FAILED: reconciler cannot SELECT FiatLiquidityReceipt after install.');
            process.exit(1);
        }
        console.log('[wp-i] reconciler opening read verified:', JSON.stringify(receipt));
        console.log('[wp-i] provenance installed. Treasury activation still requires the witness writer.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => {
    console.error('[wp-i] installer failed:', e.message);
    process.exit(1);
});
