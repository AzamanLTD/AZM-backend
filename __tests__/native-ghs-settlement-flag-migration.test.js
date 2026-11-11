// =============================================================================
// GlobalSettings.nativeGhsSettlementEnabled — migration completeness + default OFF
//
// The flag existed in schema.prisma and in the release overlay installer, but no
// migration added the column. A migrate-based provisioning path therefore had a
// silent gap. This suite proves the gap is closed and that closing it changes
// nothing about the flag's value:
//
//   1. static: schema declares the column with @default(false)
//   2. static: the migration is additive and idempotent
//                 (ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT false, no UPDATE,
//                  no DROP, no SET DEFAULT true)
//   3. static: the release installer issues the SAME statement, so the two paths
//                 cannot drift
//   4. real PostgreSQL: the migration applies twice without error against a
//                 database where the overlay already created the column, and an
//                 existing value is preserved across both applications
//   5. real PostgreSQL: the release installer runs and leaves the value alone
//   6. real PostgreSQL (scratch schema): against a table WITHOUT the column, the
//                 migration ADDS it with the default false and keeps the row
//
// Nothing here enables the flag or touches an authority latch.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = path.join(ROOT, 'prisma/schema.prisma');
const MIGRATION = path.join(ROOT, 'prisma/migrations/20261108140000_native_ghs_settlement_flag/migration.sql');
const INSTALLER = path.join(ROOT, 'infra/install-native-ghs-settlement-overlay.js');
const COLUMN = 'nativeGhsSettlementEnabled';

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();
const read = (p) => fs.readFileSync(p, 'utf8');

describe('native-GHS settlement flag: migration and installer', () => {
    test('schema declares the column with @default(false)', () => {
        const schema = read(SCHEMA);
        expect(schema).toMatch(new RegExp(`${COLUMN}\\s+Boolean\\s+@default\\(false\\)`));
        // No other default is acceptable: the flag must be OFF on a fresh model.
        expect(schema).not.toMatch(new RegExp(`${COLUMN}\\s+Boolean\\s+@default\\(true\\)`));
    });

    test('the migration is additive, idempotent and cannot rewrite existing values', () => {
        const sql = read(MIGRATION);
        const body = collapse(sql.replace(/--[^\n]*/g, ''));

        expect(body).toMatch(
            new RegExp(`ALTER TABLE "GlobalSettings" ADD COLUMN IF NOT EXISTS "${COLUMN}" BOOLEAN NOT NULL DEFAULT false;`)
        );
        // Preservation: nothing may UPDATE rows, drop the column, or flip a default.
        expect(body).not.toMatch(/UPDATE\s+"?GlobalSettings"?/i);
        expect(body).not.toMatch(/DROP\s+COLUMN/i);
        expect(body).not.toMatch(/SET\s+DEFAULT\s+true/i);
        expect(body).not.toMatch(/SET\s+NOT\s+NULL/i); // we add it NOT NULL, never relax/tighten later
        expect(body).not.toMatch(/authorityActivatedAt|fiatLiquidityAuthorityEnabled|nativeGhsWithdrawalEnabled/i);
    });

    test('the release installer issues the same statement, so the two paths cannot drift', () => {
        const installer = collapse(read(INSTALLER));
        expect(installer).toContain(
            collapse(`ADD COLUMN IF NOT EXISTS "${COLUMN}" BOOLEAN NOT NULL DEFAULT false`)
        );
        // The installer must not enable the feature: it only guarantees the guard column.
        expect(installer).not.toMatch(/SET\s+"?nativeGhsSettlementEnabled"?\s*=\s*true/i);
        expect(installer).not.toMatch(/UPDATE\s+"?GlobalSettings"?/i);
    });
});

// ── real PostgreSQL ─────────────────────────────────────────────────────────

const TEST_URL = process.env.TEST_DATABASE_URL;
const hasDb = !!TEST_URL;
if (!hasDb) console.warn('[native-ghs-settlement-flag-migration] TEST_DATABASE_URL not set — DB half skipped.');

const runInDatabase = async (fn) => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    try {
        return await fn(prisma);
    } finally {
        await prisma.$disconnect();
    }
};

const migrationSql = () =>
    read(MIGRATION)
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim();

describe('native-GHS settlement flag against real PostgreSQL', () => {
    (hasDb ? test : test.skip)('applies twice where the overlay already created the column, preserving the value', async () => {
        await runInDatabase(async (prisma) => {
            await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

            // Pin a NON-default value so "preserved" is a real assertion, and restore
            // it in a finally: this suite must never leave the flag switched on.
            const before = await prisma.globalSettings.findUnique({
                where: { id: 1 },
                select: { [COLUMN]: true },
            });
            const pinned = !before[COLUMN];
            try {
                if (pinned) {
                    await prisma.globalSettings.update({ where: { id: 1 }, data: { [COLUMN]: true } });
                }
                const pinnedValue = (await prisma.globalSettings.findUnique({
                    where: { id: 1 }, select: { [COLUMN]: true },
                }))[COLUMN];

                const sql = migrationSql();
                await prisma.$executeRawUnsafe(sql);
                await prisma.$executeRawUnsafe(sql);

                const after = await prisma.globalSettings.findUnique({
                    where: { id: 1 }, select: { [COLUMN]: true },
                });
                expect(after[COLUMN]).toBe(pinnedValue);
            } finally {
                if (pinned) {
                    await prisma.globalSettings.update({ where: { id: 1 }, data: { [COLUMN]: false } });
                }
            }

            const cols = await prisma.$queryRawUnsafe(
                `SELECT is_nullable, column_default FROM information_schema.columns
                  WHERE table_name = 'GlobalSettings' AND column_name = $1`,
                COLUMN
            );
            expect(cols).toHaveLength(1);
            expect(cols[0].is_nullable).toBe('NO');
            expect(String(cols[0].column_default)).toMatch(/false/i);
        });
    }, 60000);

    (hasDb ? test : test.skip)('the release installer runs idempotently and leaves the flag alone', async () => {
        await runInDatabase(async (prisma) => {
            await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
        });

        const before = await runInDatabase((prisma) =>
            prisma.globalSettings.findUnique({ where: { id: 1 }, select: { [COLUMN]: true } }));
        const valueBefore = before[COLUMN];

        const out = execFileSync(process.execPath, ['infra/install-native-ghs-settlement-overlay.js'], {
            cwd: ROOT,
            env: { ...process.env, DATABASE_URL: TEST_URL },
            encoding: 'utf8',
        });
        expect(out).toMatch(/nativeGhsSettlementEnabled guard in place/);

        // Second run: still idempotent.
        execFileSync(process.execPath, ['infra/install-native-ghs-settlement-overlay.js'], {
            cwd: ROOT,
            env: { ...process.env, DATABASE_URL: TEST_URL },
            encoding: 'utf8',
        });

        const after = await runInDatabase((prisma) =>
            prisma.globalSettings.findUnique({ where: { id: 1 }, select: { [COLUMN]: true } }));
        expect(after[COLUMN]).toBe(valueBefore);
    }, 60000);

    (hasDb ? test : test.skip)('against a table WITHOUT the column, the migration adds it as NOT NULL DEFAULT false', async () => {
        const schemaName = `flagmig_${process.pid}_${Date.now()}`;
        const { Client } = require('pg');
        const client = new Client({ connectionString: TEST_URL });
        await client.connect();
        try {
            await client.query(`CREATE SCHEMA "${schemaName}"`);
            await client.query(`CREATE TABLE "${schemaName}"."GlobalSettings" (id integer PRIMARY KEY)`);
            await client.query(`INSERT INTO "${schemaName}"."GlobalSettings" (id) VALUES (1)`);

            // The migration is unqualified, so it resolves through search_path exactly
            // as it would in the real database.
            await client.query(`SET search_path TO "${schemaName}"`);
            await client.query(migrationSql());
            await client.query(migrationSql()); // idempotent on the second application

            const cols = await client.query(
                `SELECT is_nullable, column_default FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = 'GlobalSettings' AND column_name = $2`,
                [schemaName, COLUMN]
            );
            expect(cols.rowCount).toBe(1);
            expect(cols.rows[0].is_nullable).toBe('NO');
            expect(String(cols.rows[0].column_default)).toMatch(/false/i);

            const row = await client.query(`SELECT "${COLUMN}" AS v FROM "${schemaName}"."GlobalSettings" WHERE id = 1`);
            expect(row.rows[0].v).toBe(false);
        } finally {
            await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {});
            await client.end();
        }
    }, 60000);
});
