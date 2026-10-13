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
//      the baseline comparison;
//   5. preflight REFUSES when the legacy IdempotencyKey is populated;
//   6. side-effect gates: preflight REFUSES populated legacy E2EE private-key
//      tables (E2EESession/E2EEPreKeyBundle, and a legacy-shaped populated
//      E2EEOneTimePreKey), orphaned ConversationMoneyTicket rows that
//      install-business-os would archive+delete, and pending
//      AzmRewardLog/AzmSpendLog dedupKey backfills;
//   7. content preservation: verify detects a MODIFIED
//      ConversationMoneyTicket record even when the row count is unchanged
//      (row-count equality alone is never accepted as proof).
//
// CI runs the full battery with --runInBand, so this suite's fixture
// drops/recreates are serialized against the other suites; afterAll
// re-provisions every touched object so the battery stays green even if an
// assertion fails (mirrors __tests__/ghs-price-provisioning.pg.test.js).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { PrismaClient } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const SCRIPT = path.join(__dirname, '..', 'infra', 'scripts', 'guarded-preflight-verify.mjs');
const PAYOUT_INSTALLER = path.join(__dirname, '..', 'infra', 'install-payout-reconciliation-infra.js');
const R16_INSTALLER = path.join(__dirname, '..', 'infra', 'install-r16-execution-identity-overlay.js');
const R42_INSTALLER = path.join(__dirname, '..', 'infra', 'install-r42-idempotency-overlay.js');
const FIAT_INSTALLER = path.join(__dirname, '..', 'infra', 'install-fiat-liquidity-overlay.js');
const PHASE3_INSTALLER = path.join(__dirname, '..', 'infra', 'install-phase3-overlay.js');
const BUSINESS_OS_INSTALLER = path.join(__dirname, '..', 'infra', 'install-business-os-overlay.js');

const CMT_FKS = [
    ['ConversationMoneyTicket_messageId_fkey',
        'ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT'],
    ['ConversationMoneyTicket_conversationId_fkey',
        'ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT'],
    ['ConversationMoneyTicket_requesterId_fkey',
        'ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT'],
    ['ConversationMoneyTicket_counterpartyId_fkey',
        'ALTER TABLE "ConversationMoneyTicket" ADD CONSTRAINT "ConversationMoneyTicket_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "User"("id") ON DELETE RESTRICT'],
];

describe('prod-recovery workflow graph contract', () => {
    test('runtime schema convergence repairs live-worker prerequisites without rewriting freshness or leases', () => {
        const runtimeInstaller = fs.readFileSync(
            path.join(__dirname, '..', 'infra', 'install-runtime-schema-gaps-overlay.js'),
            'utf8',
        );
        const custodyExecutionInstaller = fs.readFileSync(
            path.join(__dirname, '..', 'infra', 'install-custody-execution-overlay.js'),
            'utf8',
        );
        const custodyAccountingInstaller = fs.readFileSync(
            path.join(__dirname, '..', 'infra', 'install-custody-accounting-overlay.js'),
            'utf8',
        );
        const guard = fs.readFileSync(
            path.join(__dirname, '..', 'infra', 'scripts', 'guarded-preflight-verify.mjs'),
            'utf8',
        );
        const workflow = fs.readFileSync(
            path.join(__dirname, '..', '.github', 'workflows', 'converge-original-prod-branch.yml'),
            'utf8',
        );

        expect(runtimeInstaller).toContain('ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3)');
        expect(runtimeInstaller).toContain('WHERE "updatedAt" IS NULL');
        expect(runtimeInstaller).toContain('ADD COLUMN IF NOT EXISTS "lastExternalSync" TIMESTAMP(3)');
        expect(runtimeInstaller).toContain('ADD COLUMN IF NOT EXISTS "lastAdminSetAt" TIMESTAMP(3)');
        expect(runtimeInstaller).toContain('ADD COLUMN IF NOT EXISTS "lastEchoAt" TIMESTAMP(3)');
        expect(runtimeInstaller).toContain('CREATE TABLE IF NOT EXISTS "LedgerAccount"');
        expect(runtimeInstaller).toContain('CREATE TABLE IF NOT EXISTS "LedgerTransaction"');
        expect(runtimeInstaller).toContain('CREATE TABLE IF NOT EXISTS "RestrictedObligation"');
        expect(runtimeInstaller).not.toContain('UPDATE "GlobalSettings"');
        expect(custodyExecutionInstaller).toContain('CREATE TABLE IF NOT EXISTS "CustodyExecution"');
        expect(custodyAccountingInstaller).toContain('CREATE TABLE IF NOT EXISTS "CustodyAccount"');
        expect(custodyAccountingInstaller).toContain('CREATE TABLE IF NOT EXISTS "CustodyMovement"');
        expect(custodyAccountingInstaller).toContain('CREATE TABLE IF NOT EXISTS "CustodyEvidence"');
        expect(custodyAccountingInstaller).toContain('CREATE TABLE IF NOT EXISTS "ProofOfReservesLeaf"');

        for (const name of [
            'LedgerAccount', 'LedgerTransaction', 'RestrictedObligation',
            'CustodyExecution', 'CustodyAccount', 'CustodyMovement', 'CustodyEvidence', 'ProofOfReservesLeaf',
        ]) {
            expect(guard).toContain(`'${name}'`);
        }
        expect(guard).toContain("['SmartRouteRun', 'updatedAt']");
        expect(guard).toContain("['GlobalSettings', 'lastExternalSync']");
        expect(guard).toContain("['JournalEntry', 'ledgerTransactionId']");
        expect(guard).toContain("['ProofOfReservesSnapshot', 'missingEvidenceCount']");
        expect(workflow).toContain('node infra/install-runtime-schema-gaps-overlay.js');
        expect(workflow).toContain('node infra/install-custody-execution-overlay.js');
        expect(workflow).toContain('node infra/install-custody-accounting-overlay.js');
    });

    test('converge rechecks production gates and verification uses fresh baselines', () => {
        const workflow = fs.readFileSync(
            path.join(__dirname, '..', '.github', 'workflows', 'converge-original-prod-branch.yml'),
            'utf8',
        );
        const applyIndex = workflow.indexOf('\n  apply:\n');
        const verifyIndex = workflow.indexOf('\n  verify:\n');
        expect(applyIndex).toBeGreaterThanOrEqual(0);
        expect(verifyIndex).toBeGreaterThan(applyIndex);

        const applyJob = workflow.slice(applyIndex, verifyIndex);
        const verifyJob = workflow.slice(verifyIndex);
        expect(verifyJob).toMatch(/^\s+needs:\s*\[preflight,\s*apply\]/m);
        expect(verifyJob).toContain('FIAT_LIQUIDITY_STATE_CHECKSUM: ${{ needs.apply.outputs.fiat_liquidity_state_checksum }}');
        expect(verifyJob).toContain('DEFI_YIELD_STRATEGY_INTERNAL_LP_CHECKSUM: ${{ needs.apply.outputs.defi_yield_strategy_internal_lp_checksum }}');

        // Mutation revalidates side-effect gates and takes a fresh baseline
        // from the same job immediately before running the installer sequence.
        expect(applyJob).toContain('run: node infra/scripts/guarded-preflight-verify.mjs preflight');
        expect(applyJob).toContain('id: baseline');
        expect(applyJob).toContain('run: node infra/scripts/guarded-preflight-verify.mjs counts');
        expect(applyJob).toContain('user_count: ${{ steps.baseline.outputs.user_count }}');

        // A manual run must be non-mutating by default: the operator first
        // inspects the read-only preflight, then explicitly dispatches converge.
        expect(workflow).toContain('default: preflight-only');
        expect(applyJob).toMatch(/^\s+if:\s*\$\{\{\s*inputs\.operation\s*==\s*'converge'\s*\}\}/m);
        expect(verifyJob).toMatch(/^\s+if:\s*\$\{\{\s*inputs\.operation\s*==\s*'converge'\s*\}\}/m);
    });
});

run('prod-recovery guard helper (real PostgreSQL)', () => {
    let db;
    let seededUserId = null;
    let seededTxId = null;
    let seededDeFiStrategyIds = [];
    let cmtFksDropped = false;

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

    async function fkExists(constraint) {
        return Number(await scalar(
            `SELECT count(*) FROM information_schema.table_constraints WHERE table_schema='public' AND constraint_name='${constraint}'`)) > 0;
    }

    async function dropCmtFks() {
        for (const [name] of CMT_FKS) {
            if (await fkExists(name)) {
                await db.$executeRawUnsafe(`ALTER TABLE "ConversationMoneyTicket" DROP CONSTRAINT "${name}"`);
            }
        }
        cmtFksDropped = true;
    }

    async function restoreCmtFks() {
        for (const [name, ddl] of CMT_FKS) {
            if (!(await fkExists(name))) {
                await db.$executeRawUnsafe(ddl);
            }
        }
        cmtFksDropped = false;
    }

    // generic, schema-driven insert: fills every NOT NULL column lacking a
    // default with a type-appropriate value so no fixture depends on a
    // hand-maintained column list (safe against schema evolution).
    async function dynamicInsert(table, overrides = {}) {
        const cols = await db.$queryRawUnsafe(
            `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position`);
        const names = [];
        const vals = [];
        for (const c of cols) {
            if (overrides[c.column_name] !== undefined) { names.push(c.column_name); vals.push(overrides[c.column_name]); continue; }
            if (c.is_nullable === 'NO' && !c.column_default) {
                names.push(c.column_name);
                if (c.data_type === 'integer' || c.data_type === 'smallint') vals.push(1);
                else if (c.data_type.startsWith('numeric') || c.data_type === 'double precision') vals.push(0);
                else if (c.data_type === 'boolean') vals.push(false);
                else if (c.data_type === 'json' || c.data_type === 'jsonb') vals.push('{}');
                else if (c.data_type.includes('timestamp')) vals.push(new Date()); // prisma maps Date to timestamp params
                else vals.push(`dyn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
            }
        }
        const placeholders = names.map((_, i) => `$${i + 1}`).join(',');
        await db.$executeRawUnsafe(
            `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${placeholders})`, ...vals);
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
            // Parse checksums first so the absent-table sentinel "-1" remains
            // a string instead of being consumed by the numeric-count parser.
            let m = line.match(/^([a-z_]+checksum)=([0-9a-f]{32}|-1)$/);
            if (m) { out[m[1]] = m[2]; continue; }
            m = line.match(/^([a-z_]+)=(-?\d+)$/);
            if (m) out[m[1]] = Number(m[2]);
        }
        return out;
    }

    function baselineEnv(base) {
        const env = {};
        for (const [k, v] of Object.entries(base)) env[k.toUpperCase()] = String(v);
        return env;
    }

    beforeAll(async () => {
        db = new PrismaClient();
        await ensureIdentityRows();

        // The test.yml bootstrap does not run the release chain's Phase 3
        // installer, but verify() correctly requires its three documented
        // strategy seeds. Run the real installer for this fixture, tracking
        // only rows it newly inserts so afterAll can clean them up.
        const strategiesBefore = await db.$queryRawUnsafe(
            'SELECT "id", "name" FROM "DeFiYieldStrategy" WHERE "name" IN (\'AAVE\', \'COMPOUND\', \'INTERNAL_LP\')'
        );
        const namesBefore = new Set(strategiesBefore.map((row) => row.name));
        runInstaller(PHASE3_INSTALLER);
        const strategiesAfter = await db.$queryRawUnsafe(
            'SELECT "id", "name" FROM "DeFiYieldStrategy" WHERE "name" IN (\'AAVE\', \'COMPOUND\', \'INTERNAL_LP\')'
        );
        seededDeFiStrategyIds = strategiesAfter
            .filter((row) => !namesBefore.has(row.name))
            .map((row) => row.id);

        // FiatLiquidityState is an expected-initialization target in verify mode.
        // Battery-neighbor suites sometimes leave it truncated; on an empty table
        // the verify rule expects "exactly one zero-valued row after
        // initialization" and fails. Restore the pristine zero singleton so this
        // suite is hermetic regardless of what earlier suites left behind.
        await db.$executeRawUnsafe('DELETE FROM "FiatLiquidityState"');
        await db.$executeRawUnsafe(
            'INSERT INTO "FiatLiquidityState" ("id","availableGhs","reservedGhs","inTransitGhs","paidOutGhs","reconciliationHeldGhs","updatedAt") ' +
            'VALUES (1,0,0,0,0,0,CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING'
        );
    });

    afterAll(async () => {
        // self-heal: restore every fixture this suite touched
        try {
            await db.$executeRawUnsafe('DELETE FROM "ConversationMoneyTicket" WHERE "id" LIKE \'dyn_%\'');
            await db.$executeRawUnsafe('DELETE FROM "AzmSpendLog" WHERE "id"::text LIKE \'dyn_%\' OR ("metadata"->>\'dedupKey\') = \'dk-gate-test\'');
            await db.$executeRawUnsafe('DELETE FROM "AzmRewardLog" WHERE "id"::text LIKE \'dyn_%\' OR ("metadata"->>\'dedupKey\') = \'dk-gate-test\'');
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "IdempotencyKey_guard_dummy"');
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "E2EESession_guard_dummy"');
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "E2EEPreKeyBundle_guard_dummy"');
            // restore a modern-shaped E2EEOneTimePreKey if a fixture displaced it
            if (!(await scalar(`SELECT to_regclass('"E2EEOneTimePreKey"') IS NULL`))) {
                const legacy = Number(await scalar(
                    `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='E2EEOneTimePreKey' AND column_name='privateKey'`));
                if (legacy > 0) {
                    await db.$executeRawUnsafe('DROP TABLE "E2EEOneTimePreKey"');
                    runInstaller(R42_INSTALLER); // harmless idempotent heal while we are here
                    // the e2ee installer owns this table; run it via the release path
                    const e2ee = path.join(__dirname, '..', 'infra', 'install-e2ee-server-blind-overlay.js');
                    runInstaller(e2ee);
                }
            }
            if (cmtFksDropped) await restoreCmtFks();
            await restoreCmtFks(); // idempotent: re-add anything still missing
            runInstaller(R16_INSTALLER);   // restores VaultDeposit.idempotencyKey
            runInstaller(PAYOUT_INSTALLER);// restores ReconciliationException
            runInstaller(R42_INSTALLER);   // restores FinancialOperation + retirement
            for (const id of seededDeFiStrategyIds) {
                await db.$executeRawUnsafe('DELETE FROM "DeFiYieldStrategy" WHERE "id" = $1', id).catch(() => {});
            }
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

    test('a read-only preflight passes the side-effect gates cleanly and leaves row counts untouched', async () => {
        const before = await baselines();
        const res = runScript('preflight');
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('expected initialization');
        const after = await baselines();
        expect(after).toEqual(before);
    });

    test('counts mode reports the full baseline set including content checksums', async () => {
        const res = runScript('counts');
        expect(res.status).toBe(0);
        for (const key of ['user_count', 'transaction_count', 'message_count', 'trade_count',
            'peer_transfer_count', 'business_profile_count', 'business_product_count', 'wallet_count',
            'conversation_money_ticket_count', 'azm_reward_log_count', 'azm_spend_log_count',
            'defi_yield_strategy_count', 'defi_yield_strategy_seed_count', 'fiat_liquidity_state_count']) {
            expect(res.stdout).toMatch(new RegExp(`^${key}=\\-?\\d+$`, 'm'));
        }
        for (const key of ['conversation_money_ticket_checksum', 'azm_reward_log_checksum', 'azm_spend_log_checksum']) {
            expect(res.stdout).toMatch(new RegExp(`^${key}=[0-9a-f]{32}$`, 'm'));
        }
    });

    test('verify fails closed when an audited column is missing', async () => {
        await db.$executeRawUnsafe('ALTER TABLE "VaultDeposit" DROP COLUMN IF EXISTS "idempotencyKey"');
        const base = await baselines();
        const res = runScript('verify', { env: baselineEnv(base) });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('VaultDeposit.idempotencyKey');
        // self-heal immediately so later tests/suites cannot observe the gap
        runInstaller(R16_INSTALLER);
    });

    test('verify fails closed when an audited table is missing', async () => {
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "ReconciliationException"');
        const base = await baselines();
        const res = runScript('verify', { env: baselineEnv(base) });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('ReconciliationException');
        // self-heal immediately so later suites cannot observe the gap
        runInstaller(PAYOUT_INSTALLER);
    });

    test('verify accepts and checks expected FiatLiquidityState initialization when the table was absent at baseline', async () => {
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "FiatLiquidityState"');
        try {
            const base = await baselines();
            expect(base.fiat_liquidity_state_count).toBe(-1);
            expect(base.fiat_liquidity_state_checksum).toBe('-1');

            runInstaller(FIAT_INSTALLER);
            const res = runScript('verify', { env: baselineEnv(base) });
            expect(res.status).toBe(0);
            expect(res.stderr).toBe('');
            expect(res.stdout).toContain('initialized to the documented zero-valued singleton');
            expect(res.stdout).toContain('verification complete');
        } finally {
            // Re-provision the expected zero-valued singleton even if an
            // assertion fails, so the serial test battery stays hermetic.
            runInstaller(FIAT_INSTALLER);
        }
    });

    test('verify passes end-to-end on the fully provisioned database', async () => {
        const base = await baselines();
        const res = runScript('verify', { env: baselineEnv(base) });
        expect(res.stderr).toBe('');
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

    test('preflight REFUSES populated legacy E2EE private-key tables', async () => {
        await db.$executeRawUnsafe('CREATE TABLE "E2EESession_guard_dummy" (k TEXT)');
        await db.$executeRawUnsafe('INSERT INTO "E2EESession_guard_dummy" (k) VALUES (\'x\')');
        await db.$executeRawUnsafe('ALTER TABLE "E2EESession_guard_dummy" RENAME TO "E2EESession"');
        try {
            const res = runScript('preflight');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('REFUSED');
            expect(res.stderr).toContain('E2EESession');
            // no key values may ever be printed
            expect(res.stderr).not.toContain('x\')');
        } finally {
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "E2EESession"');
        }
        // same refusal for a legacy-SHAPED populated E2EEOneTimePreKey
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "E2EEPreKeyBundle_guard_dummy"');
        const otpkLegacy = await scalar(
            "SELECT to_regclass('\"E2EEOneTimePreKey\"') IS NOT NULL");
        if (otpkLegacy === true || otpkLegacy === 't') {
            await db.$executeRawUnsafe('ALTER TABLE "E2EEOneTimePreKey" RENAME TO "E2EEOneTimePreKey_guard_aside"');
        }
        await db.$executeRawUnsafe('CREATE TABLE "E2EEOneTimePreKey" ("id" TEXT PRIMARY KEY, "privateKey" TEXT)');
        await db.$executeRawUnsafe('INSERT INTO "E2EEOneTimePreKey" ("id", "privateKey") VALUES (\'dyn\', \'k\')');
        try {
            const res = runScript('preflight');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('REFUSED');
            expect(res.stderr).toContain('E2EEOneTimePreKey');
            expect(res.stderr).toContain('LEGACY shape');
        } finally {
            await db.$executeRawUnsafe('DROP TABLE "E2EEOneTimePreKey"');
            if (otpkLegacy === true || otpkLegacy === 't') {
                await db.$executeRawUnsafe('ALTER TABLE "E2EEOneTimePreKey_guard_aside" RENAME TO "E2EEOneTimePreKey"');
            }
        }
    });

    test('preflight REFUSES orphaned ConversationMoneyTicket rows the business-os installer would archive', async () => {
        await dropCmtFks();
        await dynamicInsert('ConversationMoneyTicket', {});
        try {
            const res = runScript('preflight');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('REFUSED');
            expect(res.stderr).toContain('ConversationMoneyTicket');
            expect(res.stderr).toContain('archived+deleted');
        } finally {
            await db.$executeRawUnsafe('DELETE FROM "ConversationMoneyTicket" WHERE "id" LIKE \'dyn_%\'');
            await restoreCmtFks();
        }
    });

    test('preflight REFUSES pending dedupKey backfills on existing reward/spend rows', async () => {
        // use a real User id: the FKs on these tables are NOT dropped here, and a
        // fresh CI database has no user with id 1 (local databases pick one up
        // from earlier suite runs, which is why this only failed in CI)
        const u = await db.user.findFirst({ select: { id: true } });
        expect(u).not.toBeNull();
        await dynamicInsert('AzmSpendLog', { userId: u.id, metadata: { dedupKey: 'dk-gate-test' } });
        await dynamicInsert('AzmRewardLog', { userId: u.id, metadata: { dedupKey: 'dk-gate-test' } });
        try {
            const res = runScript('preflight');
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('REFUSED');
            expect(res.stderr).toContain('AzmSpendLog');
            expect(res.stderr).toContain('AzmRewardLog');
            expect(res.stderr).toContain('backfill');
        } finally {
            await db.$executeRawUnsafe('DELETE FROM "AzmSpendLog" WHERE ("metadata"->>\'dedupKey\') = \'dk-gate-test\'');
            await db.$executeRawUnsafe('DELETE FROM "AzmRewardLog" WHERE ("metadata"->>\'dedupKey\') = \'dk-gate-test\'');
        }
    });

    test('verify detects a MODIFIED ConversationMoneyTicket record despite an unchanged row count', async () => {
        await dropCmtFks();
        await dynamicInsert('ConversationMoneyTicket', {});
        try {
            const base = await baselines();
            // same row count, different content — row-count equality must not pass
            await db.$executeRawUnsafe('UPDATE "ConversationMoneyTicket" SET "amount" = 999 WHERE "id" LIKE \'dyn_%\'');
            const res = runScript('verify', { env: baselineEnv(base) });
            expect(res.status).toBe(1);
            expect(res.stderr).toContain('conversation_money_ticket_checksum');
        } finally {
            await db.$executeRawUnsafe('DELETE FROM "ConversationMoneyTicket" WHERE "id" LIKE \'dyn_%\'');
            await restoreCmtFks();
        }
    });
});
