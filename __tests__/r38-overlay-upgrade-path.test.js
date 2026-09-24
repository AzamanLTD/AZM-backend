// __tests__/r38-overlay-upgrade-path.test.js
// =============================================================================
// r38/P0 — OVERLAY UPGRADE PATH + FAIL-CLOSED INSTALLER (real PostgreSQL).
//
// Two production-shape proofs the r37 drift suite did not cover:
//
// 1. UPGRADE PATH (not fresh install): a database holding a PRE-r37
//    BusinessLedgerEntry table WITHOUT the reversalOfId column. The overlay
//    previously created the unique index BEFORE the column existed — the
//    index statement failed, the failure was SWALLOWED (exit 0), and the
//    production release proceeded WITHOUT the DB uniqueness invariant the
//    r37 reversal code depends on. Proofs: the upgrade applies the column
//    AND the index, duplicate reversalOfId is rejected by the engine, and
//    the overlay is rerunnable (exit 0 on second run).
//
// 2. FAIL-CLOSED INSTALLER: an unexpected DDL failure must exit NON-ZERO so
//    `npm run release` (a `&&` chain) and CI abort instead of shipping a
//    schema the code does not expect.
// =============================================================================
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r38/P0 — overlay upgrade path + fail-closed installer', () => {
    let db;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });

    const runOverlay = () => spawnSync('node', [path.join(__dirname, '..', 'infra', 'install-business-os-overlay.js')], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
    });

    // r39/P0 — battery-hermetic restore helper. `prisma db push
    // --accept-data-loss` synchronizes the database to schema.prisma and
    // therefore DROPS every raw-SQL-managed overlay table (TransactionQuote,
    // ProofOfReservesLeaf, ReconciliationException, …) that has no Prisma
    // model. The restore step below uses it, so the restore must re-run the
    // FULL CI overlay set — re-running only the businessOS overlay (the old
    // restore) silently poisoned every later suite that touches a
    // raw-SQL-managed table. All installers are idempotent.
    const runAllOverlays = () => {
        const fs = require('fs');
        const infraDir = path.join(__dirname, '..', 'infra');
        let worst = 0;
        for (const f of fs.readdirSync(infraDir).filter((n) => n.startsWith('install-') && n.endsWith('.js')).sort()) {
            const r = spawnSync('node', [path.join(infraDir, f)], {
                env: { ...process.env, DATABASE_URL: url },
                encoding: 'utf8',
            });
            if (r.status !== 0 && worst === 0) worst = r.status;
        }
        return { status: worst };
    };

    const indexesOn = async (table) =>
        (await db.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`, table
        )).map((r) => r.indexname);

    const columnsOf = async (table) =>
        (await db.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
            table
        )).map((r) => r.column_name);

    // ── 1. Upgrade path: pre-r37 table without reversalOfId ─────────────────

    test('BEFORE: simulate the pre-r37 shape (BusinessLedgerEntry WITHOUT reversalOfId)', async () => {
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "BusinessLedgerEntry" CASCADE');
        // Pre-r37 shape: same columns minus reversalOfId.
        await db.$executeRawUnsafe(`CREATE TABLE "BusinessLedgerEntry" (
            "id" TEXT NOT NULL,
            "businessProfileId" TEXT NOT NULL,
            "type" VARCHAR(50) NOT NULL,
            "category" VARCHAR(100) NOT NULL,
            "description" VARCHAR(500) NOT NULL,
            "amount" DECIMAL(20,8) NOT NULL,
            "amountGhs" DECIMAL(20,8),
            "sourceType" VARCHAR(50),
            "sourceId" TEXT,
            "metadata" JSONB,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "BusinessLedgerEntry_pkey" PRIMARY KEY ("id")
        );`);
        expect(await columnsOf('BusinessLedgerEntry')).not.toContain('reversalOfId');
        expect(await indexesOn('BusinessLedgerEntry')).not.toContain('BusinessLedgerEntry_reversalOfId_key');
    });

    test('UPGRADE: overlay repairs the pre-r37 shape — column AND unique index, exit 0', () => {
        const res = runOverlay();
        expect(res.status).toBe(0); // r38: a healthy upgrade is a healthy exit
    });

    test('POST-UPGRADE: reversalOfId exists with the DB uniqueness invariant, and a duplicate is REJECTED', async () => {
        expect(await columnsOf('BusinessLedgerEntry')).toContain('reversalOfId');
        expect(await indexesOn('BusinessLedgerEntry')).toContain('BusinessLedgerEntry_reversalOfId_key');

        // The overlay-recreated table enforces the BusinessProfile FK —
        // use a real profile so the duplicate-proof isolates the unique index.
        const { seedBusiness } = require('./helpers/factories');
        const { biz } = await seedBusiness(db);
        let seq = 0;
        const mk = async (reversalOfId) => db.$executeRawUnsafe(
            `INSERT INTO "BusinessLedgerEntry" ("id", "businessProfileId", "type", "category", "description", "amount", "reversalOfId")
             VALUES ($1, $2, 'INCOME', 'C', 'd', 1.0, $3)`,
            `row-${biz.id.slice(0, 8)}-${++seq}`, biz.id, reversalOfId
        );
        await mk('dup-target');
        await expect(mk('dup-target')).rejects.toThrow(); // unique index bites
        // NULL reversalOfId stays unrestricted (multiple NULLs allowed).
        await mk(null);
        await mk(null);
    });

    test('RERUN: overlay is idempotent against the upgraded shape (exit 0)', () => {
        const res = runOverlay();
        expect(res.status).toBe(0);
    });

    // ── 2. Fail-closed installer ─────────────────────────────────────────────

    test('UNEXPECTED DDL failure → overlay exits NON-ZERO (release/CI abort)', async () => {
        // Break the schema in a way the overlay CANNOT repair: a leaf table
        // whose reversalOfId column has an index-incompatible TYPE (JSONB).
        // The overlay's ADD COLUMN IF NOT EXISTS correctly skips (column
        // exists) and its CREATE UNIQUE INDEX on the column then fails on a
        // real DDL type error. BusinessLedgerEntry is a leaf (no child FKs),
        // so the restore is hermetic — dropping and re-pushing cannot orphan
        // other tables' rows.
        const beforeColumns = await columnsOf('BusinessLedgerEntry');
        expect(beforeColumns).toContain('reversalOfId');

        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "BusinessLedgerEntry" CASCADE');
        await db.$executeRawUnsafe(`CREATE TABLE "BusinessLedgerEntry" (
            "id" TEXT NOT NULL,
            "businessProfileId" TEXT NOT NULL,
            "type" VARCHAR(50) NOT NULL,
            "category" VARCHAR(100) NOT NULL,
            "description" VARCHAR(500) NOT NULL,
            "amount" DECIMAL(20,8) NOT NULL,
            "reversalOfId" JSONB,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "BusinessLedgerEntry_pkey" PRIMARY KEY ("id")
        );`);

        let res;
        try {
            res = runOverlay();
            // The exit CODE is the fail-closed contract: `npm run release`
            // is a `&&` chain, so a non-zero exit aborts the deployment
            // instead of shipping a schema without the uniqueness invariant.
            expect(res.status).not.toBe(0);
        } finally {
            // Restore for the rest of the battery: drop the poisoned leaf
            // table and push the real schema back.
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "BusinessLedgerEntry" CASCADE');
            const push = spawnSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, DATABASE_URL: url },
                encoding: 'utf8',
            });
            if (push.status !== 0) {
                console.error('RESTORE PUSH FAILED:\n' + (push.stdout || '') + (push.stderr || ''));
            }
            expect(push.status).toBe(0);
            // Overlay objects are part of the battery baseline — ALL of
            // them: the db push above dropped every raw-SQL-managed table
            // (r39/P0 battery-hermetic restore, see runAllOverlays).
            expect(runAllOverlays().status).toBe(0);
            expect(runOverlay().status).toBe(0);
            expect(await columnsOf('BusinessLedgerEntry')).toEqual(beforeColumns);
        }
    });
});
