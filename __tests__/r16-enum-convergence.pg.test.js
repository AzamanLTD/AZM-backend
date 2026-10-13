// r16/r16c SmartRouteRunStatus enum convergence — release-chain DDL authority.
// =============================================================================
// The production deploy path (DEPLOY_RUNBOOK.md) is `npm run release` → the
// additive overlay installers; `prisma db push` / `migrate deploy` are NOT
// production paths. On greenfield databases db push creates the FULL enum, so
// CI never sees the gap; on a production branch whose enum predates r16c the
// deployed prisma client rejects every lease/reconciliation query with 22P02
// ("invalid input value for enum SmartRouteRunStatus") — observed live on the
// original production branch 2026-10-13 (smartRouteWorker fail-closed, one
// error per poll).
//
// This suite proves infra/install-r16-execution-identity-overlay.js:
//   1. converges the enum FROM the legacy pre-r16c shape (6 values) so the DB
//      enum contains EVERY value declared in prisma/schema.prisma,
//   2. never removes a value already present (additive-only), and
//   3. a second run is a successful idempotent replay.
//
// CI runs the full battery with --runInBand, so this suite's type recreation
// is serialized against the other suites; afterAll restores the full db-push
// shape (enum values + column NOT NULL + both status indexes + rows) even if
// an assertion fails.
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
if (!url) console.warn('[r16-enum] TEST_DATABASE_URL not set — skipping.');

const INSTALLER = path.join(__dirname, '..', 'infra', 'install-r16-execution-identity-overlay.js');
const SCHEMA = path.join(__dirname, '..', 'prisma', 'schema.prisma');

// The legacy pre-r16c production shape (exact value set observed on the
// original production branch 2026-10-13).
const LEGACY_VALUES = [
    'SUCCESS', 'FAILED_INSUFFICIENT', 'FAILED_GATEWAY', 'FAILED_OTHER', 'SKIPPED', 'PENDING',
];

const BACKUP_TABLE = 'azm_r16_enum_test_backup';

function schemaEnumValues() {
    const src = fs.readFileSync(SCHEMA, 'utf8');
    const m = src.match(/enum SmartRouteRunStatus \{([\s\S]*?)\}/);
    if (!m) throw new Error('SmartRouteRunStatus not found in prisma/schema.prisma');
    return m[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'))
        .map((l) => l.split(/\s+/)[0]);
}

function runInstaller(label) {
    const res = spawnSync('node', [INSTALLER], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
    });
    if (res.status !== 0) {
        throw new Error(
            `${label}: installer exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
        );
    }
    return res;
}

run('SmartRouteRunStatus release-path enum convergence (real PostgreSQL)', () => {
    let db;
    const wantValues = schemaEnumValues();

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        // Self-heal: restore the full db-push shape regardless of what the
        // assertions did, then leave the installer-green state behind for any
        // suite that follows.
        try {
            await db.$executeRawUnsafe(
                `ALTER TABLE "SmartRouteRun" ALTER COLUMN "status" DROP NOT NULL;`
            );
        } catch { /* column may not exist yet or already nullable */ }
        for (const v of wantValues) {
            await db.$executeRawUnsafe(
                `DO $$ BEGIN
                    ALTER TYPE "SmartRouteRunStatus" ADD VALUE IF NOT EXISTS '${v}';
                EXCEPTION
                    WHEN duplicate_object THEN NULL;
                END $$;`
            );
        }
        await db.$executeRawUnsafe(
            `ALTER TABLE "SmartRouteRun" ALTER COLUMN "status" SET NOT NULL;`
        );
        await db.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "SmartRouteRun_status_idx" ON "SmartRouteRun"("status");`
        );
        await db.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "SmartRouteRun_status_createdAt_idx"
                ON "SmartRouteRun"("status", "createdAt" DESC);`
        );
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${BACKUP_TABLE}";`);
        await db.$disconnect();
    });

    async function enumValues() {
        // Read pg_enum (the catalog) rather than enum_range(): pooled
        // connections cache the enum's typcache/plan, so values added by
        // the installer's separate connection can be invisible to a session
        // that already referenced the type (observed with the pg driver).
        const rows = await db.$queryRawUnsafe(
            `SELECT e.enumlabel AS v
             FROM pg_enum e
             JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'SmartRouteRunStatus'
             ORDER BY e.enumsortorder;`
        );
        return rows.map((r) => r.v);
    }

    it('contract: the prisma schema declares more than the legacy enum had', () => {
        for (const v of LEGACY_VALUES) expect(wantValues).toContain(v);
        expect(wantValues).toEqual(expect.arrayContaining(['EXECUTING', 'AWAITING_RECONCILIATION']));
        expect(wantValues.length).toBeGreaterThan(LEGACY_VALUES.length);
    });

    it('converges the legacy pre-r16c enum to the full schema value set through the release installer', async () => {
        // Recreate the exact legacy production shape observed 2026-10-13.
        // Rows are disposable test-fixture data; rows holding r16c values
        // cannot exist in the legacy shape, so they are cleared first.
        await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${BACKUP_TABLE}";`);
        await db.$executeRawUnsafe(
            `DELETE FROM "SmartRouteRun" WHERE "status"::text NOT IN (${LEGACY_VALUES.map((v) => `'${v}'`).join(',')});`
        );
        await db.$executeRawUnsafe(
            `CREATE TABLE "${BACKUP_TABLE}" AS SELECT id, "status"::text AS status FROM "SmartRouteRun";`
        );
        await db.$executeRawUnsafe(`ALTER TABLE "SmartRouteRun" DROP COLUMN "status";`);
        await db.$executeRawUnsafe(`DROP TYPE "SmartRouteRunStatus";`);
        await db.$executeRawUnsafe(
            `CREATE TYPE "SmartRouteRunStatus" AS ENUM (${LEGACY_VALUES.map((v) => `'${v}'`).join(',')});`
        );
        await db.$executeRawUnsafe(`ALTER TABLE "SmartRouteRun" ADD COLUMN "status" "SmartRouteRunStatus";`);
        await db.$executeRawUnsafe(
            `UPDATE "SmartRouteRun" r SET "status" = b.status::"SmartRouteRunStatus"
             FROM "${BACKUP_TABLE}" b WHERE r.id = b.id;`
        );
        await db.$executeRawUnsafe(`ALTER TABLE "SmartRouteRun" ALTER COLUMN "status" SET NOT NULL;`);

        const before = await enumValues();
        expect(before).toEqual(expect.arrayContaining(LEGACY_VALUES));
        expect(before).not.toContain('EXECUTING');
        expect(before).not.toContain('AWAITING_RECONCILIATION');

        // The failing production query shape from the live incident: a WHERE
        // on the r16c lease value must be rejected BEFORE convergence.
        await expect(
            db.$queryRawUnsafe(`SELECT 1 FROM "SmartRouteRun" WHERE "status" = 'EXECUTING';`)
        ).rejects.toThrow();

        runInstaller('from-legacy');

        const after = await enumValues();
        // Additive-only: nothing was removed…
        for (const v of before) expect(after).toContain(v);
        // …and every value the deployed prisma schema declares now exists.
        for (const v of wantValues) expect(after).toContain(v);

        // The incident query now executes (rows may or may not exist).
        await db.$queryRawUnsafe(`SELECT 1 FROM "SmartRouteRun" WHERE "status" = 'EXECUTING';`);
        await db.$queryRawUnsafe(
            `SELECT 1 FROM "SmartRouteRun" WHERE "status" = 'AWAITING_RECONCILIATION';`
        );
    });

    it('second installer run is a successful idempotent replay', async () => {
        const before = await enumValues();
        runInstaller('replay');
        const after = await enumValues();
        expect(after).toEqual(before);
        expect(after).toEqual(expect.arrayContaining(wantValues));
    });
});
