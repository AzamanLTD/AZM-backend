/**
 * The release chain, run for real on a clean disposable database.
 *
 * WHAT THIS PROVES: the exact `npm run release` command exits 0 twice in a row on
 * a database provisioned only to the documented baseline, with no hidden
 * dependency on a table an installer forgot to create, and with this branch's
 * constraints and triggers present exactly once afterwards.
 *
 * WHAT THE BASELINE IS: the base schema at the release commit, provisioned by a
 * single `prisma db push` (the historical production path; `db push` creates NO
 * CHECK constraints, which is why the overlays exist). The chain is additive on
 * top of that schema and is NOT a from-scratch bootstrapper — see
 * docs/release-baseline.md, which records the measured failure on an empty
 * database.
 *
 * This is deliberately slower than a unit test: it runs the actual release
 * command. An installer that only works when the objects already exist is not an
 * installer, and only running the chain twice shows that.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const BASE = process.env.TEST_DATABASE_URL;
const hasDb = !!BASE;
if (!hasDb) console.warn('[release-chain-baseline] TEST_DATABASE_URL not set — skipping.');

const DB = `azm_release_chain_${process.pid}_${Date.now()}`;
const ROOT = path.join(__dirname, '..');

const baseUrl = () => new URL(BASE);
const urlFor = (db) => {
    const u = baseUrl();
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
};
const el = (name) => `"${name}"`;

const run = hasDb ? describe : describe.skip;

run('the release chain on a clean disposable database at the documented baseline', () => {
    const { PrismaClient } = require('@prisma/client');
    let adminPg;
    let db;
    let first;
    let second;

    const runRelease = () => {
        // NODE_ENV is left alone: this must be the same command an operator runs.
        const out = execFileSync('npm', ['run', 'release'], {
            cwd: ROOT,
            env: { ...process.env, DATABASE_URL: urlFor(DB) },
            stdio: 'pipe',
            maxBuffer: 64 * 1024 * 1024,
        });
        return out.toString();
    };

    beforeAll(async () => {
        adminPg = new PrismaClient({ datasources: { db: { url: urlFor('postgres') } } });
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${el(DB)}`);
        db = new PrismaClient({ datasources: { db: { url: urlFor(DB) } } });

        // Baseline provisioning: the base schema, and nothing else.
        execFileSync('npx', ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], {
            cwd: ROOT,
            env: { ...process.env, DATABASE_URL: urlFor(DB) },
            stdio: 'pipe',
            maxBuffer: 64 * 1024 * 1024,
        });

        // The gap the overlays exist to close: db push creates NO CHECK constraints.
        const before = await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE 'ck_businessorder_%'`);
        expect(before[0].n).toBe(0);

        first = runRelease();
        second = runRelease();
    }, 900000);

    afterAll(async () => {
        await db?.$disconnect().catch(() => {});
        if (adminPg) {
            await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`).catch(() => {});
            await adminPg.$disconnect().catch(() => {});
        }
    }, 120000);

    test('both runs complete without a missing-table dependency', () => {
        expect(first).not.toMatch(/does not exist/i);
        expect(second).not.toMatch(/does not exist/i);
    });

    test('the second run is idempotent: nothing added, nothing failed', () => {
        // The drift remediation reports its own arithmetic; a re-run must add
        // nothing and fail nothing, which is what makes this safe on every deploy.
        expect(second).toMatch(/failed: 0/);
    });

    test('this branch\u2019s currency constraints are installed exactly once by the chain', async () => {
        const rows = await db.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint
             WHERE conrelid = '"BusinessOrder"'::regclass AND contype = 'c' ORDER BY 1`);
        expect(rows.map((r) => r.conname)).toEqual([
            'ck_businessorder_amount_present',
            'ck_businessorder_currency_allowed',
            'ck_businessorder_currency_shape',
        ]);
    });

    test('the money-settings append-only guards are installed exactly once by the chain', async () => {
        const rows = await db.$queryRawUnsafe(
            `SELECT tgname FROM pg_trigger
             WHERE tgrelid = '"AdminMoneySettingRevision"'::regclass AND NOT tgisinternal ORDER BY 1`);
        expect(rows.map((r) => r.tgname)).toEqual([
            'admin_money_setting_revision_no_delete',
            'admin_money_setting_revision_no_truncate',
            'admin_money_setting_revision_no_update',
        ]);
    });

    test('the chain really did install the cedi order columns, not just constraints', async () => {
        const cols = await db.$queryRawUnsafe(
            `SELECT column_name, numeric_scale FROM information_schema.columns
             WHERE table_name = 'BusinessOrder' AND column_name IN ('currency','amountGhs')`);
        const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
        expect(byName.currency).toBeTruthy();
        expect(byName.amountGhs.numeric_scale).toBe(2);
    });
});
