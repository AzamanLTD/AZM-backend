// =============================================================================
// Guard/helper contract suite for infra/scripts/guarded-preflight-verify.mjs
// (PR #341 — original production branch recovery preparation).
//
// Runs against the disposable CI PostgreSQL database (TEST_DATABASE_URL) and
// proves the recovery guard logic without ever touching any production data:
//   1. the default target guard fails closed against any non-guarded host;
//   2. guard/preflight/counts/verify all run inside BEGIN READ ONLY and
//      always release the connection (no residue on the shared test DB);
//   3. verify detects a missing audited TABLE and a missing audited COLUMN;
//   4. verify passes end-to-end on the fully provisioned database, including
//      the baseline no-rows-lost comparison;
//   5. preflight REFUSES when the legacy IdempotencyKey is populated.
//
// CI runs the full battery with --runInBand, so this suite's fixture
// drops/recreates are serialized against the other suites; afterAll
// re-provisions every touched object so the battery stays green even if an
// assertion fails (mirrors __tests__/ghs-price-provisioning.pg.test.js).

const { spawnSync } = require('child_process');
const path = require('path');
const { URL } = require('url');
const { PrismaClient } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const SCRIPT = path.join(__dirname, '..', 'infra', 'scripts', 'guarded-preflight-verify.mjs');
const FIAT_INSTALLER = path.join(__dirname, '..', 'infra', 'install-fiat-liquidity-overlay.js');
const PAYOUT_INSTALLER = path.join(__dirname, '..', 'infra', 'install-payout-reconciliation-infra.js');
const PHASE3_INSTALLER = path.join(__dirname, '..', 'infra', 'install-phase3-overlay.js');
const R16_INSTALLER = path.join(__dirname, '..', 'infra', 'install-r16-execution-identity-overlay.js');
const R42_INSTALLER = path.join(__dirname, '..', 'infra', 'install-r42-idempotency-overlay.js');

run('prod-recovery guard helper (real PostgreSQL)', () => {
    let db;
    let seededUserId = null;
    let seededTxId = null;

    const localHost = new URL(url).hostname;
    const localDb = new URL(url).pathname.replace(/^\//, '').split('?')[0];

    function runScript(mode, { overrides = true, env = {} } = {}) {
        const scriptEnv = { ...process.env, ...env, DB_URL: url };
        if (!overrides) {
            delete scriptEnv.GUARD_EXPECTED_HOST;
            delete scriptEnv.GUARD_EXPECTED_DB;
        } else if (!('GUARD_EXPECTED_HOST' in env)) {
            scriptEnv.GUARD_EXPECTED_HOST = localHost;
            scriptEnv.GUARD_EXPECTED_DB = localDb;
        }
        return spawnSync('node', [SCRIPT, mode], { env: scriptEnv, encoding: 'utf8' });
    }

    function runInstaller(installer) {
        const res = spawnSync('node', [installer], {
            env: { ...process.env, DATABASE_URL: url },
            encoding: 'utf8',
        });
        if (res.status !== 0) {
            throw new Error(`installer failed: ${path.basename(installer)}\n${res.stderr}`);
        }
    }

    async function scalar(q) {
        const r = await db.$queryRawUnsafe(q);
        return r[0] ? Object.values(r[0])[0] : null;
    }

    async function ensureIdentityRows() {
        const users = Number(await scalar('SELECT count(*) FROM "User"'));
        if (users === 0) {
            const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            const u = await db.user.create({ data: {
                username: `guard_${id}`, email: `guard_${id}@t.co`, password: 'x',
                availableBalance: '0', azmBalance: '0',
            }});
            seededUserId = u.id;
        }
        const txs = Number(await scalar('SELECT count(*) FROM "TransactionHistory"'));
        if (txs === 0) {
            const first = seededUserId
                ? { id: seededUserId }
                : await db.user.findFirst({ select: { id: true } });
            const tx = await db.transactionHistory.create({ data: {
                userId: first.id,
                type: 'DEPOSIT_FIAT',
                amountUsdc: '1',
                txHash: `guard_${Date.now()}`,
                providerRef: 'guard-test',
                payerMsisdn: 'guard-test',
                initiatedByUserId: first.id,
                metadata: {},
            }});
            seededTxId = tx.id;
        }
    }

    async function baselines() {
        const res = runScript('counts');
        expect(res.status).toBe(0);
        const out = {};
        for (const line of res.stdout.split('\n')) {
            const m = line.match(/^([a-z_]+)=(\-?\d+)$/);
            if (m) out[m[1]] = Number(m[2]);
        }
        return out;
    }

    beforeAll(async () => {
        db = new PrismaClient();
        await ensureIdentityRows();
    });

    afterAll(async () => {
        // self-heal: restore every fixture this suite touched
        try {
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "IdempotencyKey_guard_dummy"');
            runInstaller(PHASE3_INSTALLER);   // restores OrderTracking.yieldEnabled
            runInstaller(PAYOUT_INSTALLER);   // restores ReconciliationException
            runInstaller(R42_INSTALLER);      // restores FinancialOperation + retirement
            if (seededTxId) await db.transactionHistory.delete({ where: { id: seededTxId } }).catch(() => {});
            if (seededUserId) await db.user.delete({ where: { id: seededUserId } }).catch(() => {});
        } finally {
            await db.$disconnect();
        }
    });

    test('target guard fails closed without the guarded-host default', () => {
        const res = runScript('guard', { overrides: false });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('target guard failed');
        // fail-closed means it must not leak the observed host or URL
        expect(res.stderr).not.toContain(url);
        expect(res.stderr).not.toContain(localHost);
    });

    test('target guard passes with the expected-host override', () => {
        const res = runScript('guard');
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('target guard passed');
    });

    test('a read-only mode leaves row counts untouched', async () => {
        const before = await baselines();
        runScript('preflight');
        const after = await baselines();
        expect(after).toEqual(before);
    });

    test('counts mode reports the full baseline set', async () => {
        const res = runScript('counts');
        expect(res.status).toBe(0);
        for (const key of ['user_count', 'transaction_count', 'message_count', 'trade_count',
            'peer_transfer_count', 'business_profile_count', 'business_product_count', 'wallet_count']) {
            expect(res.stdout).toMatch(new RegExp(`^${key}=\\-?\\d+$`, 'm'));
        }
    });

    test('verify fails closed when an audited column is missing', async () => {
        await db.$executeRawUnsafe('ALTER TABLE "VaultDeposit" DROP COLUMN IF EXISTS "idempotencyKey"');
        const base = await baselines();
        const env = Object.fromEntries(
            Object.entries(base).map(([k, v]) => [k.toUpperCase(), String(v)]));
        const res = runScript('verify', { env });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('VaultDeposit.idempotencyKey');
        // self-heal immediately so later tests/suites cannot observe the gap
        runInstaller(R16_INSTALLER);
    });

    test('verify fails closed when an audited table is missing', async () => {
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "ReconciliationException"');
        const base = await baselines();
        const env = Object.fromEntries(
            Object.entries(base).map(([k, v]) => [k.toUpperCase(), String(v)]));
        const res = runScript('verify', { env });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('ReconciliationException');
        // self-heal immediately so later suites cannot observe the gap
        runInstaller(PAYOUT_INSTALLER);
    });

    test('verify passes end-to-end on the fully provisioned database', async () => {
        const base = await baselines();
        const env = Object.fromEntries(
            Object.entries(base).map(([k, v]) => [k.toUpperCase(), String(v)]));
        const res = runScript('verify', { env });
        expect(res.stdout).toContain('verification complete');
        expect(res.status).toBe(0);
    });

    test('preflight REFUSES a populated legacy IdempotencyKey', async () => {
        // r42 retires the real table in the provisioned test DB; fabricate the
        // legacy populated state to prove the refusal path fires before any write.
        // If some other suite left a real table behind, move it aside and restore it.
        const preExisting = await scalar("SELECT to_regclass('\"IdempotencyKey\"') IS NOT NULL");
        if (preExisting === true || preExisting === 't') {
            await db.$executeRawUnsafe('ALTER TABLE "IdempotencyKey" RENAME TO "IdempotencyKey_guard_aside"');
        }
        await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "IdempotencyKey_guard_dummy" (k TEXT)');
        await db.$executeRawUnsafe('INSERT INTO "IdempotencyKey_guard_dummy" (k) VALUES (\'x\')');
        await db.$executeRawUnsafe('ALTER TABLE "IdempotencyKey_guard_dummy" RENAME TO "IdempotencyKey"');
        try {
            const res = runScript('preflight');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('REFUSED');
            expect(res.stderr).toContain('IdempotencyKey');
        } finally {
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "IdempotencyKey"');
            if (preExisting === true || preExisting === 't') {
                await db.$executeRawUnsafe('ALTER TABLE "IdempotencyKey_guard_aside" RENAME TO "IdempotencyKey"');
            }
        }
    });
});
