#!/usr/bin/env node
// Idempotent additive installer for the WP-I settlement witness table
// (docs/wp-i-reconciler-runbook.md).
//
// WHY THIS EXISTS: Render's release command does not run Prisma migrations, so a
// clean production database only ever sees the schema-overlay battery. The
// fiat-liquidity overlay backfills FiatLiquidityReceipt.walletAccount FROM
// "ProviderSettlementWitness", and before this installer existed nothing in the
// release path created that table — a clean release failed on the backfill
// capsule with `relation "ProviderSettlementWitness" does not exist`. This
// installer therefore runs BEFORE install-fiat-liquidity-overlay.js.
//
// Contract of the overlay battery, kept here exactly: DATABASE_URL is the only
// input, every statement is guarded, running it repeatedly is safe, and it
// creates no rows. Financial state is untouched: the table starts empty and the
// witness writer is a separate, explicitly authorised activation step.
//
// The GRANTS that make a witness un-authorable by the runtime identity are NOT
// here: they need two role names and must refuse to run without them, so they
// live in infra/wp-i/install-witness-provenance.js.

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "ProviderSettlementWitness" (
    "id" TEXT NOT NULL,
    "openingDedupKey" TEXT NOT NULL,
    "observationKey" TEXT,
    "provider" TEXT NOT NULL,
    "fundingType" TEXT NOT NULL,
    "witnessKind" TEXT NOT NULL,
    "walletAccount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "netPesewas" BIGINT NOT NULL,
    "grossPesewas" BIGINT,
    "providerState" TEXT NOT NULL,
    "adapterRule" TEXT,
    "endpoint" TEXT NOT NULL,
    "requestParams" JSONB NOT NULL,
    "rawResponseDigest" TEXT NOT NULL,
    "rawResponse" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderSettlementWitness_pkey" PRIMARY KEY ("id")
  );`,

  // Upgrades for a table that predates a column. Nullable where Prisma allows
  // null, so an existing installation is never broken by the upgrade.
  `ALTER TABLE "ProviderSettlementWitness" ADD COLUMN IF NOT EXISTS "observationKey" TEXT`,
  `ALTER TABLE "ProviderSettlementWitness" ADD COLUMN IF NOT EXISTS "grossPesewas" BIGINT`,
  `ALTER TABLE "ProviderSettlementWitness" ADD COLUMN IF NOT EXISTS "adapterRule" TEXT`,

  // One opening, one witness. One OBSERVATION, one witness — the DB, not the
  // application, is the authority that a single provider settlement cannot fund
  // two treasury openings.
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSettlementWitness_openingDedupKey_key"
     ON "ProviderSettlementWitness"("openingDedupKey");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSettlementWitness_observationKey_key"
     ON "ProviderSettlementWitness"("observationKey");`,
  `CREATE INDEX IF NOT EXISTS "ProviderSettlementWitness_provider_openingDedupKey_idx"
     ON "ProviderSettlementWitness"("provider", "openingDedupKey");`,
];


// ── §7 ROLE PROVISIONING (OPT-IN) ───────────────────────────────────────────
// The witness grants are only meaningful if they are applied by the installer
// rather than recreated by hand in a test. They are OPT-IN because the release
// chain runs with an application credential that may not hold CREATEROLE, and a
// chain that fails on a permission it was never granted would block every other
// installer. Absent the flag, this installer says so and continues.
const PROVISION_ROLES = process.env.WP_I_PROVISION_WITNESS_ROLES === '1';
const RUNTIME_ROLE = process.env.WP_I_RUNTIME_ROLE || 'azam_wp_i_runtime';
const RECONCILER_ROLE = process.env.WP_I_RECONCILER_ROLE || 'azam_wp_i_reconciler';

async function provisionWitnessRoles(client) {
    const [me] = await client.$queryRawUnsafe(
        'SELECT current_user AS u, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user',
    );
    if (!me || (!me.rolsuper && !me.rolcreaterole)) {
        console.log('[wp-i witness] role provisioning skipped: ' + (me && me.u) + ' cannot create roles');
        return { provisioned: false, reason: 'NO_CREATEROLE' };
    }
    // CREATE ROLE has no IF NOT EXISTS, so existence is checked first: a second
    // run must be a no-op, not an error.
    for (const role of [RUNTIME_ROLE, RECONCILER_ROLE]) {
        const [exists] = await client.$queryRawUnsafe('SELECT 1 AS x FROM pg_roles WHERE rolname = $1', role);
        if (!exists) {
            await client.$executeRawUnsafe('CREATE ROLE "' + role + '" LOGIN');
            console.log('[wp-i witness] created role ' + role);
        }
    }
    // Least privilege, restated on every run so a drifted grant is repaired.
    await client.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO "' + RUNTIME_ROLE + '"');
    await client.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO "' + RECONCILER_ROLE + '"');
    await client.$executeRawUnsafe('GRANT SELECT ON "ProviderSettlementWitness" TO "' + RUNTIME_ROLE + '"');
    await client.$executeRawUnsafe('GRANT SELECT, INSERT ON "ProviderSettlementWitness" TO "' + RECONCILER_ROLE + '"');
    // Explicitly NOT granted: UPDATE/DELETE/TRUNCATE to either role, and any
    // privilege at all on customer balances, deposits or the ledger.
    await client.$executeRawUnsafe('REVOKE UPDATE, DELETE, TRUNCATE ON "ProviderSettlementWitness" FROM "' + RUNTIME_ROLE + '"');
    await client.$executeRawUnsafe('REVOKE UPDATE, DELETE, TRUNCATE ON "ProviderSettlementWitness" FROM "' + RECONCILER_ROLE + '"');
    return { provisioned: true };
}

async function main() {
    if (PROVISION_ROLES) {
        const out = await provisionWitnessRoles(prisma);
        console.log('[wp-i witness] roles: ' + JSON.stringify(out));
    } else {
        console.log('[wp-i witness] role provisioning not requested (WP_I_PROVISION_WITNESS_ROLES != 1)');
    }
    for (const sql of STATEMENTS) {
        await prisma.$executeRawUnsafe(sql);
        console.log(`[wp-i witness] ok: ${sql.split('\n')[0].slice(0, 96)}`);
    }

    // Prove the shape rather than trusting the statements: a table that exists
    // with a missing unique index would silently allow double funding.
    const cols = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'ProviderSettlementWitness' ORDER BY column_name`
    );
    const names = cols.map((c) => c.column_name);
    const required = [
        'id', 'openingDedupKey', 'observationKey', 'provider', 'fundingType', 'witnessKind',
        'walletAccount', 'currency', 'netPesewas', 'grossPesewas', 'providerState', 'adapterRule',
        'endpoint', 'requestParams', 'rawResponseDigest', 'rawResponse', 'fetchedAt', 'createdAt',
    ];
    const missingCols = required.filter((c) => !names.includes(c));
    if (missingCols.length > 0) {
        console.error(`[wp-i witness] FAILED: missing columns ${missingCols.join(', ')}`);
        process.exit(1);
    }

    const idx = await prisma.$queryRawUnsafe(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'ProviderSettlementWitness'`
    );
    const idxNames = idx.map((r) => r.indexname);
    for (const need of [
        'ProviderSettlementWitness_openingDedupKey_key',
        'ProviderSettlementWitness_observationKey_key',
        'ProviderSettlementWitness_provider_openingDedupKey_idx',
    ]) {
        if (!idxNames.includes(need)) {
            console.error(`[wp-i witness] FAILED: missing index ${need}`);
            process.exit(1);
        }
    }
    console.log(`[wp-i witness] verified ${names.length} columns and ${idxNames.length} indexes`);
}

if (require.main === module) {
    main()
        .then(() => prisma.$disconnect())
        .catch(async (e) => {
            console.error('[wp-i witness] installer failed:', e.message);
            await prisma.$disconnect();
            process.exit(1);
        });
}

// Exported so the provenance suite can provision through THIS installer rather
// than restating its grants. Running the file directly still executes it.
module.exports = { runInstaller: main };
