// __tests__/r271e-approved-withdrawal-recovery.test.js
// =============================================================================
// r271e P0 #1 — the APPROVED withdrawal is no longer a dead-end.
//
// THE DEFECT: admin approval flipped the mirror PENDING -> APPROVED, but NO
// authority ever looked at APPROVED again: the payout worker scanned only
// PENDING, admin rejection refused APPROVED, and the reconciliation scan
// skipped APPROVED. A worker restart (or any missed tick) between approve and
// claim left the row approved-but-eternal: the user was debited, the admin
// had authorized, and no code path on earth would ever dispatch, refund, or
// even SEE the row again.
//
// THE FIX (pinned here, real PostgreSQL through the real controllers/workers):
//   1. The payout worker scans and dispatch-claims APPROVED rows exactly like
//      PENDING rows (single CAS winner at the dispatch boundary).
//   2. Admin rejection accepts APPROVED (provably undispatched — the dispatch
//      claim is the only writer of PROCESSING and the safety gate re-verifies
//      live evidence) and refunds through the SAME canonical reversal.
//   3. The reconciliation scan includes APPROVED: a stale approved row becomes
//      a durable, visible PROVIDER_REFERENCE_NOT_FOUND exception instead of a
//      silent strand.
//
// PROOFS: happy path, reject-after-approve refund, crash-window visibility
// (recon), admin-vs-worker race at the dispatch boundary (10 rounds),
// approve-vs-reject race on a PENDING row, and regression pins that the old
// dead-end can never re-form.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r271e-approved-recovery] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r271e P0 #1: APPROVED withdrawal recovery', () => {
    let prisma, controller;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        controller = require('../controllers/adminController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "GlobalSettings", "SystemProfitFees", "SystemFiatPool", "SystemMasterCrypto", "AdminProfitLog", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

    const mkReq = (admin, body, params) => ({
        user: admin,
        body,
        params: params || {},
        app: {
            get: (k) => {
                if (k === 'prisma') return prisma;
                if (k === 'socketio') return { to: () => ({ emit: () => {} }) };
                if (k === 'notificationService') return { sendNotification: async () => ({}) };
                return null;
            },
        },
        ip: '127.0.0.1',
    });
    const mkRes = () => {
        const res = {};
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.payload = payload; return res; };
        return res;
    };

    async function approve(admin, withdrawalId) {
        const res = mkRes();
        await controller.approveWithdrawal(mkReq(admin, { adminNotes: 'test approve' }, { id: String(withdrawalId) }), res);
        return res;
    }
    async function reject(admin, withdrawalId, reason = 'r271e test rejection') {
        const res = mkRes();
        await controller.rejectWithdrawal(mkReq(admin, { reason }, { id: String(withdrawalId) }), res);
        return res;
    }

    async function seedFiatEnv() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 15, liveUsdToGhs: 15 },
            create: { id: 1, liveRetailRate: 15, liveUsdToGhs: 15 }
        });
        await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
        await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
    }

    /**
     * Seeds a canonical fiat withdrawal exactly as processFiatWithdrawal +
     * the controller bridge create it: user debited, canonical
     * TransactionHistory PENDING, Withdrawal mirror PENDING.
     */
    async function seedCanonicalWithdrawal(user, amount) {
        const financeService = require('../services/finance.service');
        const reference = `FIAT_OUT_${user.id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const result = await financeService.processFiatWithdrawal(prisma, user.id, amount, {
            reference,
            createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                const rows = await tx.$queryRawUnsafe(
                    'INSERT INTO "Withdrawal" ' +
                    '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                    'RETURNING "id", "userId", "amount", "status"',
                    user.id, amount, 'MTN_MOMO', 'MOMO', '0240000000', 'PENDING', txRecord.id
                );
                return rows?.[0] || null;
            },
        });
        const withdrawal = await prisma.withdrawal.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        return { result, withdrawal, reference };
    }

    /** A payout worker with a recording, always-accepting provider mock. */
    function makeWorker() {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const calls = [];
        const mtn = {
            async initiateTransfer(payload) {
                calls.push(payload);
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', data: { reference: payload.referenceId } };
            },
            async getTransferStatus() {
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT' };
            },
        };
        const notifications = { sendNotification: async () => ({}) };
        const worker = new PayoutBatchWorker(prisma, null, mtn, notifications);
        return { worker, calls };
    }

    test('1: the payout worker claims and dispatches an APPROVED row (the dead-end is gone)', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await seedCanonicalWithdrawal(user, 50);

        const approval = await approve(admin, withdrawal.id);
        expect(approval.statusCode).toBe(200);
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('APPROVED');

        const { worker, calls } = makeWorker();
        const summary = await worker.processNow({ force: true });

        // The worker SAW and processed the APPROVED row.
        expect(calls.length).toBe(1);
        const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(mirror.status).toBe('PROCESSING'); // dispatched, in the Moolre lifecycle
        const summaryAny = JSON.stringify(summary);
        expect(summaryAny).not.toContain('APPROVED_NOT_CLAIMABLE');

        // Dispatch evidence exists (the acceptance is durable).
        const canonical = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' },
        });
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { relatedReference: canonical.txHash, direction: 'OUTBOUND' },
        });
        expect(evidence).toBeTruthy();
        // The user was debited once and NOT refunded by the worker path.
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeLessThan(500);
    });

    test('2: admin rejection of an APPROVED row refunds exactly once through the canonical reversal', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        const approval = await approve(admin, withdrawal.id);
        expect(approval.statusCode).toBe(200);

        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(200);

        // Canonical reversed, mirror rejected.
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('REJECTED');

        // User refunded EXACTLY once (500 restored), obligation released.
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(500, 5);
        const obligations = await prisma.restrictedObligation.findMany({
            where: { reference: `withdrawal:fiat:${reference}`, status: 'ACTIVE' },
        });
        expect(obligations.length).toBe(0);
    });

    test('3: admin rejection after the WORKER has claimed the APPROVED row fails closed (409) — never a refund race', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await seedCanonicalWithdrawal(user, 50);
        await approve(admin, withdrawal.id);

        // Worker wins the dispatch claim first.
        const { worker, calls } = makeWorker();
        await worker.processNow({ force: true });
        expect(calls.length).toBe(1);
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('PROCESSING');

        // A stale admin rejection (holding an APPROVED-era snapshot) must
        // lose: the handler live-re-proofs the row and refuses — 400 (status
        // pre-check) or 409 (mirror CAS loss) — and never refunds.
        const before = await prisma.user.findUnique({ where: { id: user.id } });
        const res = await reject(admin, withdrawal.id);
        expect([400, 409]).toContain(res.statusCode);
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance)); // NO refund
    });

    test('4: a stale APPROVED row is now VISIBLE to the reconciliation scan (crash-window strand is gone)', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);
        await approve(admin, withdrawal.id);

        // Age the row past the recon staleness window (simulates a worker that
        // crashed between approve and claim).
        await prisma.$executeRawUnsafe(
            'UPDATE "Withdrawal" SET "createdAt" = now() - interval \'10 minutes\' WHERE "id" = $1',
            withdrawal.id
        );

        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const mtn = {
            async getTransferStatus() { return { status: 'NOT_FOUND', provider: 'MOOLRE_DISBURSEMENT' }; },
        };
        const recon = new WithdrawalReconciliationWorker(prisma, null, mtn, null, null);
        await recon._tick();

        // The scan SAW the APPROVED row: a durable, visible exception exists —
        // never again a silent strand.
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT "reason", "entityType", "entityId" FROM "ReconciliationException" ' +
            'WHERE "entityId" = $1 ORDER BY "id" DESC',
            String(withdrawal.id)
        );
        expect(exceptions.length).toBeGreaterThan(0);
        expect(String(exceptions[0].reason)).toBe('PROVIDER_REFERENCE_NOT_FOUND');
        // No money moved: still APPROVED, still debited, canonical untouched.
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('APPROVED');
        expect((await prisma.transactionHistory.findUnique({ where: { txHash: reference } })).status).toBe('PENDING');
    });

    test('5: RACE — admin rejection vs the worker dispatch claim on an APPROVED row: exactly one winner (10 rounds)', async () => {
        for (let round = 0; round < 10; round++) {
            await seedFiatEnv();
            const admin = await seedUser(prisma, { role: 'ADMIN' });
            const user = await seedUser(prisma, { availableBalance: 500 });
            const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
            const { withdrawal } = await seedCanonicalWithdrawal(user, 50);
            await approve(admin, withdrawal.id);

            const { worker, calls } = makeWorker();
            const [res, summary] = await Promise.all([
                reject(admin, withdrawal.id),
                worker.processNow({ force: true }).catch((e) => ({ error: e.message })),
            ]);

            const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
            const after = await prisma.user.findUnique({ where: { id: user.id } });
            const balance = Number(after.availableBalance);

            if (res.statusCode === 200) {
                // Admin won: refunded exactly once, provider NEVER called,
                // canonical reversed, and the worker skipped the row.
                expect(calls.length).toBe(0);
                expect(mirror.status).toBe('REJECTED');
                expect(balance).toBeCloseTo(before, 5);
            } else {
                // Worker won: dispatched exactly once, admin rejection
                // refused (live re-proof), user still debited.
                expect(res.statusCode).toBe(409);
                expect(calls.length).toBe(1);
                expect(['PROCESSING']).toContain(mirror.status);
                expect(balance).toBeLessThan(before);
            }
            // Invariant in BOTH branches: never refunded AND dispatched.
            expect(calls.length + (res.statusCode === 200 ? 1 : 0)).toBe(1);
        }
    });

    test('6: RACE — approve vs reject on a PENDING row: exactly one money movement, never both', async () => {
        for (let round = 0; round < 10; round++) {
            await seedFiatEnv();
            const admin = await seedUser(prisma, { role: 'ADMIN' });
            const user = await seedUser(prisma, { availableBalance: 500 });
            const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
            const { withdrawal } = await seedCanonicalWithdrawal(user, 50);

            const [approval, rejection] = await Promise.all([
                approve(admin, withdrawal.id),
                reject(admin, withdrawal.id),
            ]);

            const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
            const balance = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

            // Exactly one of the two CAS claims won the PENDING row.
            if (mirror.status === 'REJECTED') {
                expect(rejection.statusCode).toBe(200);
                expect(balance).toBeCloseTo(before, 5); // refunded exactly once
            } else if (mirror.status === 'APPROVED') {
                expect(approval.statusCode).toBe(200);
                expect([400, 409]).toContain(rejection.statusCode);
                expect(balance).toBeLessThan(before); // still debited
            } else {
                // Sequential interleaving (approve won, then reject claimed the
                // APPROVED row): refund happened exactly once — one of the two
                // documented single-winner outcomes, never a double movement.
                expect(mirror.status).toBe('REJECTED');
                expect(balance).toBeCloseTo(before, 5);
            }
        }
    });

    test('7: REGRESSION — a rejected APPROVED row can never be re-claimed by the worker', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await seedCanonicalWithdrawal(user, 50);
        await approve(admin, withdrawal.id);
        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(200);

        // A later worker pass must never dispatch a refunded row.
        const { worker, calls } = makeWorker();
        await worker.processNow({ force: true });
        expect(calls.length).toBe(0);
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('REJECTED');
    });
});
