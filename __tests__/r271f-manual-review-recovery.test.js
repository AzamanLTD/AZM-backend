// __tests__/r271f-manual-review-recovery.test.js
// =============================================================================
// r271f P0 #2 — NEEDS_MANUAL_REVIEW is no longer an unrecoverable dead-end.
//
// THE DEFECT: payout parking was durable but had NO exit and NO evidence:
//   • No admin action accepted the status — approve/reject both refused it.
//   • No worker scanned it — the row was invisible to every authority forever.
//   • Most parking sites never durably recorded WHY the row was parked, so
//     the operator could not even prove whether the provider had been paid.
//
// THE FIX (pinned here, real PostgreSQL through the real worker/controller):
//   1. Parking is FAIL-CLOSED with durable phase evidence: the reason +
//      phase are recorded as an OPEN ReconciliationException BEFORE the
//      status claim; if the evidence write fails the row is NOT parked (an
//      existing authority keeps it).
//   2. resolveManualReview gives every parked row a deterministic exit:
//        RESUME/REJECT — only with POSITIVE backend proof the provider never
//                        dispatched (safe phase record, no unknowable
//                        anomalies, no dispatch evidence, unknown ownership,
//                        PENDING canonical);
//        ESCALATE      — always available; atomically hands the row to the
//                        reconciliation authority with a durable record.
//   3. REJECT refunds through the SAME canonical reversal state machine as
//      admin rejection — single economic winner vs callbacks/reconcilers.
//
// PROOFS: fail-closed parking, resume, canonical + legacy refunds, refused
// unknowable refunds, refused legacy (evidence-less) refunds, escalation,
// concurrent resolutions (single winner), and the review-listing enrichment.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r271f-manual-review-recovery] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r271f P0 #2: NEEDS_MANUAL_REVIEW deterministic recovery', () => {
    let prisma, controller, PayoutBatchWorker;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        controller = require('../controllers/adminController');
        PayoutBatchWorker = require('../workers/payoutBatchWorker');
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
        query: {},
        app: {
            get: (k) => {
                if (k === 'prisma') return prisma;
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

    async function resolveReview(admin, withdrawalId, action, reason = 'r271f test resolution') {
        const res = mkRes();
        await controller.resolveManualReview(mkReq(admin, { action, reason }, { id: String(withdrawalId) }), res);
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

    function makeWorker() {
        const mtn = {
            async initiateTransfer(payload) {
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', data: { reference: payload.referenceId } };
            },
            async getTransferStatus() { return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT' }; },
        };
        const notifications = { sendNotification: async () => ({}) };
        return new PayoutBatchWorker(prisma, null, mtn, notifications);
    }

    const openExceptions = (withdrawalId) => prisma.$queryRawUnsafe(
        'SELECT "reason", "details" FROM "ReconciliationException" ' +
        'WHERE "status" = \'OPEN\' AND "entityType" = \'WITHDRAWAL\' AND "entityId" = $1 ' +
        'ORDER BY "id" DESC',
        String(withdrawalId)
    );

    test('1: parking records durable phase evidence and claims the row (fail-closed happy path)', async () => {
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'PENDING' },
        });
        const worker = makeWorker();

        const parked = await worker._parkForManualReview(w, 'MISSING_TRANSACTION_REFERENCE', { source: 'r271f' });
        expect(parked).toBe(true);

        const mirror = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(mirror.status).toBe('NEEDS_MANUAL_REVIEW');

        const rows = await openExceptions(w.id);
        expect(rows.length).toBe(1);
        expect(String(rows[0].reason)).toBe('MISSING_TRANSACTION_REFERENCE');
        expect(rows[0].details.phase).toBe('PRE_DISPATCH');
    });

    test('2: parking FAILS CLOSED when the evidence write fails — the row is never stranded parked-and-proofless', async () => {
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'PENDING' },
        });

        // A prisma client whose ReconciliationException INSERT always fails:
        // every other operation passes through to the real DB.
        const brokenEvidenceClient = new Proxy(prisma, {
            get(target, prop, receiver) {
                if (prop === '$queryRawUnsafe') {
                    return async (sql, ...args) => {
                        if (String(sql).includes('"ReconciliationException"') && String(sql).includes('INSERT')) {
                            throw new Error('simulated evidence-store outage');
                        }
                        return target.$queryRawUnsafe(sql, ...args);
                    };
                }
                return Reflect.get(target, prop, target);
            },
        });

        const worker = makeWorker();
        worker.prisma = brokenEvidenceClient;

        const parked = await worker._parkForManualReview(w, 'MISSING_TRANSACTION_REFERENCE', { source: 'r271f' });
        expect(parked).toBe(false); // NOT parked

        // The PENDING row is still owned by a live authority (the worker scan)
        // instead of becoming an evidence-less dead-end.
        const mirror = await prisma.withdrawal.findUnique({ where: { id: w.id } });
        expect(mirror.status).toBe('PENDING');
    });

    test('3: a post-accept park records the POST_ACCEPT phase (the unknowable class)', async () => {
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'PROCESSING' },
        });
        const worker = makeWorker();

        const flagged = await worker._flagForManualReview(w, 'DISPATCH_IDENTITY_UNKNOWN', { reference: 'ref-x' }, 'POST_ACCEPT');
        expect(flagged).toBe(true);
        expect((await prisma.withdrawal.findUnique({ where: { id: w.id } })).status).toBe('NEEDS_MANUAL_REVIEW');

        const rows = await openExceptions(w.id);
        expect(rows[0].details.phase).toBe('POST_ACCEPT');
    });

    test('4: RESUME returns a provably-not-dispatched parked row to the pipeline', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'PENDING' },
        });
        const worker = makeWorker();
        expect(await worker._parkForManualReview(w, 'MISSING_TRANSACTION_REFERENCE', {})).toBe(true);

        const res = await resolveReview(admin, w.id, 'RESUME');
        expect(res.statusCode).toBe(200);
        expect((await prisma.withdrawal.findUnique({ where: { id: w.id } })).status).toBe('PENDING');

        // The parking evidence survives for the audit trail.
        expect((await openExceptions(w.id)).length).toBe(1);
    });

    test('5: REJECT on a safe-parked canonical row refunds EXACTLY ONCE through the canonical reversal', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        // Park it pre-dispatch exactly as the worker would.
        const worker = makeWorker();
        expect(await worker._parkForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', { maxAmountUsdc: 200 })).toBe(true);

        const res = await resolveReview(admin, withdrawal.id, 'REJECT');
        expect(res.statusCode).toBe(200);

        // Canonical reversed, mirror rejected, user restored EXACTLY once.
        expect((await prisma.transactionHistory.findUnique({ where: { txHash: reference } })).status).toBe('FAILED');
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('REJECTED');
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(500, 5);
        const obligations = await prisma.restrictedObligation.findMany({
            where: { reference: `withdrawal:fiat:${reference}`, status: 'ACTIVE' },
        });
        expect(obligations.length).toBe(0);

        // Authoritative reversal ledger entry exists exactly once.
        const reversals = await prisma.ledgerTransaction.findMany({
            where: { idempotencyKey: `ledger:withdrawal:fiat:reverse:${reference}` },
        });
        expect(reversals.length).toBe(1);
    });

    test('6: REJECT is REFUSED on a post-accept parked row (the provider may have paid)', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        // Simulate the post-dispatch world: claimed PROCESSING, dispatch
        // acceptance evidence, then parked unknowable.
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'PROCESSING' } });
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE_DISBURSEMENT', rail: 'MOMO', direction: 'OUTBOUND', status: 'PENDING',
                dedupKey: `event:payout-accept:${reference}`, relatedReference: reference,
            },
        });
        const worker = makeWorker();
        const w = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(await worker._flagForManualReview(w, 'DISPATCH_IDENTITY_UNKNOWN', { reference }, 'POST_ACCEPT')).toBe(true);

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        const res = await resolveReview(admin, withdrawal.id, 'REJECT');
        expect(res.statusCode).toBe(409);
        expect(res.payload.data.blockers.length).toBeGreaterThan(0);

        // NOTHING moved: no refund, canonical untouched.
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance));
        expect((await prisma.transactionHistory.findUnique({ where: { txHash: reference } })).status).toBe('PENDING');
    });

    test('7: REJECT is REFUSED on a LEGACY parked row with no durable evidence (fail-closed to ESCALATE)', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await seedCanonicalWithdrawal(user, 50);

        // Pre-fix rows were parked with NO exception record at all.
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'NEEDS_MANUAL_REVIEW' } });

        const res = await resolveReview(admin, withdrawal.id, 'REJECT');
        expect(res.statusCode).toBe(409);
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('NEEDS_MANUAL_REVIEW');
    });

    test('8: REJECT is REFUSED when dispatch evidence contradicts a safe-phase parking record', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        const worker = makeWorker();
        expect(await worker._parkForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', { maxAmountUsdc: 200 })).toBe(true);

        // Contradicting evidence appears afterwards (a callback race wrote it).
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE_DISBURSEMENT', rail: 'MOMO', direction: 'OUTBOUND', status: 'PENDING',
                dedupKey: `event:payout-accept:${reference}`, relatedReference: reference,
            },
        });

        const res = await resolveReview(admin, withdrawal.id, 'REJECT');
        expect(res.statusCode).toBe(409); // evidence beats the phase record
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('NEEDS_MANUAL_REVIEW');
    });

    test('9: ESCALATE hands an unknowable row durably to the reconciliation authority', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'PROCESSING' } });
        const worker = makeWorker();
        const w = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(await worker._flagForManualReview(w, 'DISPATCH_IDENTITY_UNKNOWN', { reference }, 'POST_ACCEPT')).toBe(true);

        const res = await resolveReview(admin, withdrawal.id, 'ESCALATE', 'escalating to recon');
        expect(res.statusCode).toBe(200);
        expect((await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } })).status).toBe('PROCESSING');

        // The durable handoff record exists and carries the canonical ref.
        const rows = await openExceptions(withdrawal.id);
        const handoff = rows.find((r) => String(r.reason) === 'MANUAL_REVIEW_ESCALATED_TO_RECONCILIATION');
        expect(handoff).toBeTruthy();
        expect(rows.length).toBeGreaterThanOrEqual(2); // original + handoff
    });

    test('10: ESCALATE works for a LEGACY evidence-less parked row too — no row is unexitable', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'NEEDS_MANUAL_REVIEW' },
        });

        const res = await resolveReview(admin, w.id, 'ESCALATE', 'legacy row escalation');
        expect(res.statusCode).toBe(200);
        expect((await prisma.withdrawal.findUnique({ where: { id: w.id } })).status).toBe('PROCESSING');
        const rows = await openExceptions(w.id);
        expect(String(rows[0].reason)).toBe('MANUAL_REVIEW_ESCALATED_TO_RECONCILIATION');
    });

    test('11: CONCURRENT REJECT resolutions refund exactly once (single economic winner)', async () => {
        await seedFiatEnv();
        const admin1 = await seedUser(prisma, { role: 'ADMIN' });
        const admin2 = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        const worker = makeWorker();
        expect(await worker._parkForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', { maxAmountUsdc: 200 })).toBe(true);

        const [resA, resB] = await Promise.all([
            resolveReview(admin1, withdrawal.id, 'REJECT'),
            resolveReview(admin2, withdrawal.id, 'REJECT'),
        ]);

        const codes = [resA.statusCode, resB.statusCode].sort();
        expect(codes).toEqual([200, 409]); // exactly one winner
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(500, 5); // refunded ONCE
        const reversals = await prisma.ledgerTransaction.findMany({
            where: { idempotencyKey: `ledger:withdrawal:fiat:reverse:${reference}` },
        });
        expect(reversals.length).toBe(1); // one authoritative reversal post
    });

    test('12: CONCURRENT REJECT vs RESUME — exactly one outcome, never a refund AND a resume', async () => {
        await seedFiatEnv();
        const admin1 = await seedUser(prisma, { role: 'ADMIN' });
        const admin2 = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await seedCanonicalWithdrawal(user, 50);

        const worker = makeWorker();
        expect(await worker._parkForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', { maxAmountUsdc: 200 })).toBe(true);

        const [resReject, resResume] = await Promise.all([
            resolveReview(admin1, withdrawal.id, 'REJECT'),
            resolveReview(admin2, withdrawal.id, 'RESUME'),
        ]);

        const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        const balance = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        const winners = [resReject.statusCode, resResume.statusCode].filter((c) => c === 200).length;
        expect(winners).toBe(1); // exactly one winner

        if (mirror.status === 'REJECTED') {
            expect(balance).toBeCloseTo(500, 5); // refunded exactly once
        } else {
            expect(mirror.status).toBe('PENDING'); // resumed, no refund
            expect(balance).toBeLessThan(500);
        }
    });

    test('13: resolution of a non-parked row is refused (409) — the endpoint only touches parked rows', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'PENDING' },
        });

        const res = await resolveReview(admin, w.id, 'RESUME');
        expect(res.statusCode).toBe(409);
        expect((await prisma.withdrawal.findUnique({ where: { id: w.id } })).status).toBe('PENDING');
    });

    test('14: the review listing is enriched with the durable parking evidence', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'PENDING' },
        });
        const worker = makeWorker();
        expect(await worker._parkForManualReview(w, 'MISSING_TRANSACTION_REFERENCE', {})).toBe(true);

        const res = mkRes();
        await controller.getNeedsManualReview(mkReq(admin, {}, {}), res);
        expect(res.statusCode).toBe(200);

        const row = res.payload.withdrawals.find((x) => x.id === w.id);
        expect(row).toBeTruthy();
        expect(row.manualReview.reasons.length).toBe(1);
        expect(row.manualReview.reasons[0].reason).toBe('MISSING_TRANSACTION_REFERENCE');
        expect(row.manualReview.reasons[0].phase).toBe('PRE_DISPATCH');
    });

    test('15: validation — unknown action and missing reason are refused (400)', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 100 });
        const w = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 20, payoutMethod: 'MTN_MOMO', network: 'MOMO', destination: '0240000000', status: 'NEEDS_MANUAL_REVIEW' },
        });

        const badAction = await resolveReview(admin, w.id, 'REFUND_EVERYTHING');
        expect(badAction.statusCode).toBe(400);

        const noReason = await mkRes();
        await controller.resolveManualReview(mkReq(admin, { action: 'ESCALATE', reason: '' }, { id: String(w.id) }), noReason);
        expect(noReason.statusCode).toBe(400);
        expect((await prisma.withdrawal.findUnique({ where: { id: w.id } })).status).toBe('NEEDS_MANUAL_REVIEW');
    });
});
