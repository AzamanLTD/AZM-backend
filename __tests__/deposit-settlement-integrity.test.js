// __tests__/deposit-settlement-integrity.test.js
// =============================================================================
// P0 — fiat deposit EXACTLY-ONCE settlement integrity (local MoMo + Moolre).
//
// The PENDING → COMPLETED flip is the database-enforced winner claim and runs
// in the SAME transaction as the wallet credit, BEFORE it. Proofs (real
// PostgreSQL where TEST_DATABASE_URL is set — CI provides it):
//   1. sequential duplicate SUCCESS  -> one credit
//   2. concurrent  duplicate SUCCESS  -> one credit, one COMPLETED
//   3. wallet credit failure          -> claim rolls back (row stays PENDING)
//   4. SUCCESS vs FAILED race         -> exactly one consistent terminal state
//   5-8. same architecture on the Moolre collection webhook (+ replay is
//      side-effect free).
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[deposit-settlement-integrity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Deposit exactly-once settlement (real PostgreSQL)', () => {
    let prisma, depositCtrl;
    const FIAT_SECRET = 'fiat_settlement_secret';
    const MOOLRE_SECRET = 'moolre_settlement_secret';

    beforeAll(() => {
        process.env.DATABASE_URL        = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV            = 'test';
        process.env.JWT_SECRET          = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET  = FIAT_SECRET;
        process.env.MOOLRE_WEBHOOK_SECRET = MOOLRE_SECRET;
        const { PrismaClient } = require('@prisma/client');
        prisma      = new PrismaClient();
        depositCtrl = require('../controllers/depositController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.globalSettings.upsert({
            where:  { id: 1 },
            update: { liveUsdToGhs: 10.0 },
            create: { id: 1, liveUsdToGhs: 10.0 },
        });
    });

    afterEach(async () => {
        await new Promise(r => setTimeout(r, 150)); // drain setImmediate notif callbacks
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "AuditLog", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    function mockRes() {
        const r = { _status: 200, _body: null };
        r.status = (s) => { r._status = s; return r; };
        r.json   = (b) => { r._body  = b;  return r; };
        return r;
    }
    const mockApp = (p) => ({
        get: (k) => k === 'prisma' ? p : (k === 'socketio' ? { to: () => ({ emit: () => {} }) } : null),
    });

    async function seedUserWithDeposit() {
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: 0 });
        const res = mockRes();
        await depositCtrl.initiateLocalFiatDeposit(
            { user: { id: user.id }, body: { amountGhs: 100, provider: 'MTN_MOMO' }, app: mockApp(prisma) },
            res
        );
        if (res._status !== 201) throw new Error('initiate failed: ' + JSON.stringify(res._body));
        return { user, reference: res._body.data.reference };
    }

    const fiatWebhook = (reference) => ({
        body: { reference, amountGhs: 100, providerTxId: 'ptx_1', status: 'SUCCESS' },
        headers: { 'x-azaman-webhook-secret': FIAT_SECRET },
        app: mockApp(prisma), ip: '127.0.0.1',
    });

    async function seedMoolrePending(amountGhs = 100) {
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: 0 });
        const ref = `MOOLRE_TEST_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        await prisma.transactionHistory.create({
            data: {
                userId: user.id, type: 'DEPOSIT_FIAT', amountUsdc: 0, feeUsdc: 0,
                txHash: ref, status: 'PENDING',
                metadata: { amountGhs, provider: 'MTN_MOMO' },
            },
        });
        return { user, ref };
    }

    const moolreWebhook = (ref, amount = 100) => ({
        body: { status: 1, code: 'P01', data: { externalref: ref, payer: '0244000000', amount } },
        headers: { 'x-moolre-webhook-secret': MOOLRE_SECRET },
        app: mockApp(prisma), ip: '127.0.0.1',
    });

    async function failAllUserUpdates() {
        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION _azm_forbid_user_update() RETURNS trigger AS
            $$ BEGIN RAISE EXCEPTION 'forced wallet failure'; END $$ LANGUAGE plpgsql;
        `);
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER _azm_fail_user BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION _azm_forbid_user_update();`
        );
    }
    async function restoreUserUpdates() {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS _azm_fail_user ON "User"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS _azm_forbid_user_update()');
    }

    const balance = async (userId) =>
        Number((await prisma.user.findUnique({ where: { id: userId } })).availableBalance);

    // ── Local fiat ──────────────────────────────────────────────────────────
    test('1. sequential duplicate SUCCESS settles exactly once', async () => {
        const { user, reference } = await seedUserWithDeposit();

        const r1 = mockRes(); await depositCtrl.localFiatDepositWebhook(fiatWebhook(reference), r1);
        expect(r1._status).toBe(200);
        expect(r1._body.data.alreadyProcessed).toBeUndefined();

        const r2 = mockRes(); await depositCtrl.localFiatDepositWebhook(fiatWebhook(reference), r2);
        expect(r2._status).toBe(200);
        expect(r2._body.data.alreadyProcessed).toBe(true);

        expect(await balance(user.id)).toBeCloseTo(10, 6); // 100 GHS / 10 = 10 USDC, ONCE
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(row.status).toBe('COMPLETED');
    });

    test('2. concurrent duplicate SUCCESS: exactly one credit, one COMPLETED settlement', async () => {
        const { user, reference } = await seedUserWithDeposit();

        const call = () => depositCtrl
            .localFiatDepositWebhook(fiatWebhook(reference), mockRes())
            .then((r) => r._status === 200 && r._body.data?.alreadyProcessed === true
                ? { replay: true } : { settled: true })
            .catch((e) => ({ error: e }));

        const outcomes = await Promise.all([call(), call()]);
        const settled = outcomes.filter((o) => o.settled);
        expect(settled).toHaveLength(1);

        expect(await balance(user.id)).toBeCloseTo(10, 6);
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(row.status).toBe('COMPLETED');
        expect(Number(row.amountUsdc)).toBeCloseTo(10, 6);
    });

    test('3. wallet credit failure rolls the COMPLETED claim back to PENDING', async () => {
        const { user, reference } = await seedUserWithDeposit();
        await failAllUserUpdates();
        try {
            const res = mockRes();
            await depositCtrl.localFiatDepositWebhook(fiatWebhook(reference), res);
            expect(res._status).toBe(500);

            // The claim rolled back: the row is PENDING again and nothing was credited.
            const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(row.status).toBe('PENDING');
            expect(await balance(user.id)).toBeCloseTo(0, 6);

            // After the failure is gone the SAME webhook can still settle it —
            // the rollback left a consistent, retryable state.
            await restoreUserUpdates();
            const retry = mockRes();
            await depositCtrl.localFiatDepositWebhook(fiatWebhook(reference), retry);
            expect(retry._status).toBe(200);
            expect(await balance(user.id)).toBeCloseTo(10, 6);
        } finally {
            await restoreUserUpdates();
        }
    });

    test('4. SUCCESS vs FAILED race: exactly one consistent terminal state', async () => {
        const { user, reference } = await seedUserWithDeposit();

        const success = depositCtrl.localFiatDepositWebhook(fiatWebhook(reference), mockRes())
            .then((r) => ({ s: r._status })).catch((e) => ({ s: 500 }));
        const failure = depositCtrl.localFiatDepositWebhook({
            body: { reference, amountGhs: 100, status: 'FAILED' },
            headers: { 'x-azaman-webhook-secret': FIAT_SECRET },
            app: mockApp(prisma), ip: '127.0.0.1',
        }, mockRes()).then((r) => ({ f: r._status })).catch((e) => ({ f: 500 }));

        await Promise.all([success, failure]);

        const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(['COMPLETED', 'FAILED']).toContain(row.status);

        if (row.status === 'COMPLETED') {
            // The SUCCESS webhook won the PENDING claim → credited exactly once.
            expect(await balance(user.id)).toBeCloseTo(10, 6);
        } else {
            // The FAILED transition won → no credit, and a later SUCCESS
            // cannot resurrect a FAILED deposit.
            expect(await balance(user.id)).toBeCloseTo(0, 6);
            const res = mockRes();
            await depositCtrl.localFiatDepositWebhook(fiatWebhook(reference), res);
            expect(res._status).not.toBe(200);
            expect(await balance(user.id)).toBeCloseTo(0, 6);
        }
    });

    // ── Moolre ──────────────────────────────────────────────────────────────
    test('5. Moolre sequential duplicate settles exactly once', async () => {
        const { user, ref } = await seedMoolrePending();

        const r1 = mockRes(); await depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), r1);
        expect(r1._status).toBe(200);
        expect(r1._body.message).toBe('Deposit credited.');

        const r2 = mockRes(); await depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), r2);
        expect(r2._status).toBe(200);
        expect(r2._body.message).toBe('Already processed.');

        expect(await balance(user.id)).toBeCloseTo(10, 6);
    });

    test('6. Moolre concurrent duplicate: exactly one credit', async () => {
        const { user, ref } = await seedMoolrePending();

        const call = () => depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), mockRes())
            .then((r) => r._body.message).catch(() => 'error');

        const outcomes = await Promise.all([call(), call()]);
        expect(outcomes.filter((m) => m === 'Deposit credited.')).toHaveLength(1);
        expect(await balance(user.id)).toBeCloseTo(10, 6);

        const row = await prisma.transactionHistory.findUnique({ where: { txHash: ref } });
        expect(row.status).toBe('COMPLETED');
    });

    test('7. Moolre wallet credit failure rolls back the claim (retryable)', async () => {
        const { user, ref } = await seedMoolrePending();
        await failAllUserUpdates();
        try {
            const res = mockRes();
            await depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), res);
            expect(res._status).toBe(500);

            const row = await prisma.transactionHistory.findUnique({ where: { txHash: ref } });
            expect(row.status).toBe('PENDING');
            expect(await balance(user.id)).toBeCloseTo(0, 6);

            await restoreUserUpdates();
            const retry = mockRes();
            await depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), retry);
            expect(retry._body.message).toBe('Deposit credited.');
            expect(await balance(user.id)).toBeCloseTo(10, 6);
        } finally {
            await restoreUserUpdates();
        }
    });

    test('8. Moolre replay is side-effect free (no duplicate audit rows)', async () => {
        const { user, ref } = await seedMoolrePending();

        await depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), mockRes());
        const auditsAfterFirst = await prisma.auditLog.count({
            where: { action: 'DEPOSIT_MOOLRE_COMPLETED' }
        });

        await depositCtrl.moolreCollectionWebhook(moolreWebhook(ref), mockRes());
        const auditsAfterReplay = await prisma.auditLog.count({
            where: { action: 'DEPOSIT_MOOLRE_COMPLETED' }
        });

        expect(auditsAfterFirst).toBe(1);
        expect(auditsAfterReplay).toBe(1);
        expect(await balance(user.id)).toBeCloseTo(10, 6);
    });
});
