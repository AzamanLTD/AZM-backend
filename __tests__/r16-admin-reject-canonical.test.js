// __tests__/r16-admin-reject-canonical.test.js
// =============================================================================
// r16 P0-C proofs — admin rejection is canonical-state-safe.
//
// Proves against REAL PostgreSQL through the real adminController handler:
//   1. Pre-dispatch rejection (canonical PENDING, no dispatch evidence)
//      refunds EXACTLY ONCE, through the canonical reversal state machine
//      (canonical → FAILED, obligation cancelled, ledger reversed).
//   2. Rejection after dispatch evidence (DISPATCH_INTENT / acceptance)
//      fails CLOSED (409) — the cash position is unknown.
//   3. Rejection after canonical settlement (COMPLETED) fails closed (409).
//   4. Concurrent rejections of one mirror refund exactly once.
//   5. An OPEN reconciliation exception (e.g. POST_DISPATCH_BOOKKEEPING_
//      FAILED) attached to the payout fails closed — recovery belongs to
//      the reconciliation worker, never to an admin refund guess (r16b
//      P0-B).
//   6. Admin rejection racing the payout worker's PENDING -> PROCESSING
//      claim has exactly one winner — a worker-claimed payout is never
//      refunded, a rejected payout is never dispatched (r16b P0-B).
//   7. Terminal mirror statuses (COMPLETED / FAILED / CANCELLED /
//      NEEDS_MANUAL_REVIEW / PROCESSING) never refund.
//   8. A legacy pre-P4 mirror-only withdrawal rejects through the
//      documented legacy path without fabricating a modern authority
//      obligation (r16b P0-B).
//   9. r16c P0-A Scenario A — the REAL direct fiatWithdrawal controller
//      held between its reservation and its DB dispatch claim loses to
//      admin rejection: provider NEVER called, exactly one reversal
//      (10 rounds).
//   10. r16c P0-A Scenario B — the dispatch claim (PENDING -> DISPATCHING)
//      wins first: admin rejection is protected (400/409), the user is not
//      refunded, and the payout continues through the Moolre lifecycle
//      (10 rounds).
//   11. r16c — a legacy mirror-only rejection can NEVER consume an
//      unrelated active fiat obligation (the old startsWith lookup).
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r16-admin-reject] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r16 P0-C: Admin rejection canonical-state safety', () => {
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

    async function reject(admin, withdrawalId, reason = 'test rejection') {
        const res = mkRes();
        await controller.rejectWithdrawal(mkReq(admin, { reason }, { id: String(withdrawalId) }), res);
        return res;
    }

    /**
     * Seeds a canonical fiat withdrawal EXACTLY as processFiatWithdrawal
     * + the controller's in-transaction Withdrawal bridge create it:
     * user debited, canonical TransactionHistory PENDING, Withdrawal
     * mirror PENDING linked via transactionHistoryId.
     */
    async function seedCanonicalWithdrawal(user, amount) {
        await prisma.globalSettings.create({
            data: { id: 1, liveRetailRate: 15, liveUsdToGhs: 15 }
        }).catch(() => {});
        await prisma.systemFiatPool.create({ data: { id: 1, balance: 100000 } }).catch(() => {});
        await prisma.systemMasterCrypto.create({ data: { id: 1, balance: 0 } }).catch(() => {});
        await prisma.systemProfitFees.create({ data: { id: 1, balance: 0 } }).catch(() => {});

        const financeService = require('../services/finance.service');
        const reference = `FIAT_OUT_${user.id}_${Date.now()}`;
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

    test('1: pre-dispatch rejection refunds once through the canonical reversal', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        const debited = await prisma.user.findUnique({ where: { id: user.id } });
        const expectedAfterDebit = Number(debited.availableBalance); // 200 - (50+fee)

        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(200);

        // Canonical row reversed, mirror rejected.
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(mirror.status).toBe('REJECTED');

        // User refunded EXACTLY once: amount + exit fee restored.
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(200, 5);

        // Obligation released (no active reservation left behind).
        const obligations = await prisma.restrictedObligation.findMany({
            where: { reference: `withdrawal:fiat:${reference}`, status: 'ACTIVE' },
        });
        expect(obligations.length).toBe(0);
        expect(expectedAfterDebit).toBeLessThan(200);
    });

    test('2: rejection after dispatch-intent evidence fails closed (409)', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        // Dispatch-intent evidence: provider I/O may have started.
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'AZM_DISPATCHER',
                rail: 'MOMO',
                direction: 'OUTBOUND',
                status: 'DISPATCH_INTENT',
                dedupKey: `event:payout-dispatch-intent:${reference}`,
                relatedReference: reference,
            },
        });

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(409);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance)); // NO refund
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING'); // untouched — reconcile instead
    });

    test('3: rejection after canonical settlement fails closed (409)', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        // Settled at the provider: canonical COMPLETED.
        await prisma.transactionHistory.update({
            where: { txHash: reference },
            data: { status: 'COMPLETED' },
        });

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(409);

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance)); // NO double-credit
    });

    test('4: concurrent rejections refund exactly once', async () => {
        const admin1 = await seedUser(prisma, { role: 'ADMIN' });
        const admin2 = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { withdrawal } = await seedCanonicalWithdrawal(user, 50);

        const [r1, r2] = await Promise.all([
            reject(admin1, withdrawal.id),
            reject(admin2, withdrawal.id),
        ]);

        const codes = [r1.statusCode, r2.statusCode].sort();
        expect(codes).toEqual([200, 409]); // exactly one winner

        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(200, 5); // refunded ONCE
    });

    test('5: an OPEN reconciliation exception attached to the payout fails closed (409)', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        // The provider accepted the payout but post-dispatch bookkeeping
        // failed — the payoutBatchWorker parks exactly this durable state.
        await prisma.$executeRawUnsafe(
            'INSERT INTO "ReconciliationException" ("entityType", "entityId", "reference", "reason", "status") ' +
            'VALUES ($1, $2, $3, $4, \'OPEN\')',
            'WITHDRAWAL', String(withdrawal.id), reference, 'POST_DISPATCH_BOOKKEEPING_FAILED'
        );

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(409);
        expect(res.payload.data.evidence).toBe('OPEN_RECONCILIATION_EXCEPTION');

        // NOTHING moved: no refund, canonical still PENDING, obligation
        // still ACTIVE — the reconciliation worker owns recovery.
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance));
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');
        const obligations = await prisma.restrictedObligation.findMany({
            where: { reference: `withdrawal:fiat:${reference}`, status: 'ACTIVE' },
        });
        expect(obligations.length).toBe(1);
        const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(mirror.status).toBe('PENDING');
    });

    test('5b: a TRANSACTION-entity exception on the reference also fails closed (409)', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });
        const { withdrawal, reference } = await seedCanonicalWithdrawal(user, 50);

        // Smart Route / evidence-write failure shape: entityType TRANSACTION,
        // entityId = the canonical reference.
        await prisma.$executeRawUnsafe(
            'INSERT INTO "ReconciliationException" ("entityType", "entityId", "reference", "reason", "status") ' +
            'VALUES ($1, $2, $3, $4, \'OPEN\')',
            'TRANSACTION', String(reference), reference, 'POST_DISPATCH_OWNERSHIP_WRITE_FAILED'
        );

        const before = await prisma.user.findUnique({ where: { id: user.id } });
        const res = await reject(admin, withdrawal.id);
        expect(res.statusCode).toBe(409);
        expect(res.payload.data.evidence).toBe('OPEN_RECONCILIATION_EXCEPTION');

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance));
    });

    test('6: admin rejection racing the payout worker claim has exactly one winner', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });

        // Run both concurrently, several rounds — the DB must serialize
        // them into exactly one winner each round. Every round uses a
        // FRESH user so processFiatWithdrawal's pre-debit ledger audit
        // (securityCheck.runDoubleCheck) sees a consistent settled
        // balance; repeated debits on one user would legitimately freeze
        // the second withdrawal.
        for (let round = 0; round < 5; round++) {
            const user = await seedUser(prisma, { availableBalance: 200 });
            const fresh = await seedCanonicalWithdrawal(user, 50);

            // The payoutBatchWorker's guarded claim, exactly as production
            // writes it: updateMany PENDING -> PROCESSING, zero rows = lost.
            const [rejectRes, claimRes] = await Promise.all([
                reject(admin, fresh.withdrawal.id),
                prisma.withdrawal.updateMany({
                    where: { id: fresh.withdrawal.id, status: 'PENDING' },
                    data: { status: 'PROCESSING' },
                }),
            ]);

            const mirror = await prisma.withdrawal.findUnique({ where: { id: fresh.withdrawal.id } });
            const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: fresh.reference } });
            const winnerCount = (rejectRes.statusCode === 200 ? 1 : 0) + (claimRes.count === 1 ? 1 : 0);
            expect(winnerCount).toBe(1); // never both, never neither

            if (mirror.status === 'REJECTED') {
                // Admin won: full canonical reversal, exactly one refund.
                expect(canonical.status).toBe('FAILED');
            } else {
                // Worker won: payout protected, provider payout claimable by
                // the worker — and NO refund happened.
                expect(mirror.status).toBe('PROCESSING');
                expect(canonical.status).toBe('PENDING');
                // Two honest interleavings exist for the reject's loss, and
                // which one occurs is pure commit-order timing (see test 7,
                // which pins the direct-set mirror guard):
                //  (a) reject read the mirror PENDING, entered the guarded
                //      transaction, and lost the in-transaction claim → 409.
                //  (b) the worker's updateMany committed before reject's
                //      first read, so the status guard refused it → 400.
                // Both are safe single-winner outcomes: no refund, mirror
                // PROCESSING, canonical PENDING. Assert the invariants, not
                // the interleaving (same lesson as the p5r14 race fix).
                expect([400, 409]).toContain(rejectRes.statusCode);
            }
        }
    });

    test('7: terminal mirror statuses never refund', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });

        for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'NEEDS_MANUAL_REVIEW', 'PROCESSING']) {
            const user = await seedUser(prisma, { availableBalance: 200 });
            const { withdrawal } = await seedCanonicalWithdrawal(user, 50);
            await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status } });

            const before = await prisma.user.findUnique({ where: { id: user.id } });
            const res = await reject(admin, withdrawal.id);
            expect(res.statusCode).toBe(400); // status guard refuses before any financial mutation

            const after = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(after.availableBalance)).toBe(Number(before.availableBalance));
            const mirror = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
            expect(mirror.status).toBe(status); // untouched
        }
    });

    test('8: a legacy mirror-only withdrawal rejects through the documented legacy path', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const user = await seedUser(prisma, { availableBalance: 200 });

        // Pre-P4 shape: NO canonical TransactionHistory link at all.
        const rows = await prisma.$queryRawUnsafe(
            'INSERT INTO "Withdrawal" ("userId", "amount", "payoutMethod", "network", "destination", "status", "createdAt", "updatedAt") ' +
            'VALUES ($1, $2, $3, $4, $5, \'PENDING\', now(), now()) RETURNING "id"',
            user.id, 30, 'MTN_MOMO', 'MOMO', '0240000000'
        );
        const legacyId = rows[0].id;

        const res = await reject(admin, legacyId);
        expect(res.statusCode).toBe(200);

        // Mirror rejected, legacy amount refunded.
        const mirror = await prisma.withdrawal.findUnique({ where: { id: legacyId } });
        expect(mirror.status).toBe('REJECTED');

        // NO modern authority obligation was fabricated for the legacy row.
        const obligations = await prisma.restrictedObligation.findMany({
            where: { userId: user.id },
        });
        expect(obligations.length).toBe(0);

        // Legacy path refunds `Withdrawal.amount` from equity (documented
        // pre-P4 behavior — the row predates canonical reservations).
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(230, 5); // 200 + 30
    });

    // ── r16c P0-A: real direct-controller dispatch-claim races ────────────

    /**
     * Real fiatWithdrawal harness — the same injection surface the r16b
     * topology suite uses (controller reads the dispatcher from req.app).
     */
    function makeFiatHarness(dispatcher) {
        const appMap = new Map([
            ['prisma', prisma],
            ['paymentFailoverService', dispatcher],
            ['emitBalanceUpdate', async () => {}],
            ['emailService', null],
            ['smsService', null],
            ['adminAlertService', null],
            ['socketio', null],
            ['azmSpendService', null],
        ]);
        const app = { get: (k) => (appMap.has(k) ? appMap.get(k) : null) };
        const mkRes = () => {
            const r = {};
            r.status = (c) => { r.statusCode = c; return r; };
            r.json = (b) => { r.payload = b; return r; };
            return r;
        };
        return { app, mkRes };
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

    async function callFiatWithdrawal(userId, dispatcher) {
        const { fiatWithdrawal } = require('../controllers/withdrawalController');
        const { app, mkRes } = makeFiatHarness(dispatcher);
        const res = mkRes();
        const req = {
            app, ip: '127.0.0.1', headers: {},
            body: { amount: '50', payoutMethod: 'MTN_MOMO', recipientPhone: '0204556677', network: 'TELECEL' },
            user: { id: userId, username: 'r16c', createdAt: new Date(Date.now() - 90 * 86400000) },
        };
        await fiatWithdrawal(req, res);
        return res;
    }

    test('9: Scenario A — admin rejection wins the real dispatch boundary → provider NEVER called, exactly one reversal (10 rounds)', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const origReserve = financeService.processFiatWithdrawal;

        let adminWon = 0;
        let dispatchWon = 0;
        try {
        for (let round = 0; round < 10; round++) {
            const user = await seedUser(prisma, { availableBalance: 500 });
            const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

            // Latch between the reservation commit and the dispatch claim:
            // wrap processFiatWithdrawal and hold the controller there. This
            // is the exact window admin rejection must be able to win.
            let release = null;
            const entered = new Promise((resolveEnter) => {
                financeService.processFiatWithdrawal = async (...args) => {
                    const r = await origReserve.apply(financeService, args);
                    resolveEnter();
                    await new Promise((r2) => { release = r2; });
                    return r;
                };
            });

            const captured = [];
            const dispatcher = {
                async initiateTransfer(payload) {
                    captured.push(payload);
                    return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', data: { reference: payload.referenceId } };
                },
            };
            const controllerDone = callFiatWithdrawal(user.id, dispatcher);
            await entered;

            // Mirror exists (reservation committed) and is still PENDING —
            // admin rejection contends at the same DB authority.
            const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
            expect(mirror.status).toBe('PENDING');

            const admin = await seedUser(prisma, { role: 'ADMIN' });
            const res = await reject(admin, mirror.id);

            release();
            const ctrlRes = await controllerDone;
            financeService.processFiatWithdrawal = origReserve;

            if (res.statusCode === 200) {
                adminWon++;
                // The controller lost the claim → 409, provider NEVER called.
                expect(ctrlRes.statusCode).toBe(409);
                expect(captured.length).toBe(0);
                expect(ctrlRes.payload.code).toBe('WITHDRAWAL_CLAIMED_CONCURRENTLY');

                // Admin's reversal is the ONLY money movement: canonical
                // FAILED, mirror REJECTED, user restored exactly once.
                const rows = await prisma.$queryRawUnsafe(
                    'SELECT "txHash" FROM "TransactionHistory" WHERE "userId" = $1 AND "type" = \'WITHDRAWAL_FIAT\'', user.id
                );
                const canonicalRow = await prisma.transactionHistory.findUnique({ where: { txHash: rows[0].txHash } });
                expect(canonicalRow.status).toBe('FAILED');
                const finalMirror = await prisma.withdrawal.findUnique({ where: { id: mirror.id } });
                expect(finalMirror.status).toBe('REJECTED');

                const after = await prisma.user.findUnique({ where: { id: user.id } });
                expect(Number(after.availableBalance)).toBeCloseTo(before, 5); // restored exactly once

                const reversals = await prisma.ledgerTransaction.findMany({
                    where: { idempotencyKey: `ledger:withdrawal:fiat:reverse:${rows[0].txHash}` },
                });
                expect(reversals.length).toBe(1);
            } else {
                dispatchWon++;
                // The dispatch claim won the row first — rejection is
                // protected and the user was NOT refunded by the admin path.
                expect([400, 409]).toContain(res.statusCode);
                const afterAdmin = await prisma.user.findUnique({ where: { id: user.id } });
                expect(Number(afterAdmin.availableBalance)).toBeLessThan(before); // still debited
            }
        }
        } finally {
            financeService.processFiatWithdrawal = origReserve;
        }
        // With the latch, admin rejection completes while the controller is
        // held BEFORE the claim — every round must be an admin win.
        expect(adminWon).toBe(10);
        expect(dispatchWon).toBe(0);
    });

    test('10: Scenario B — dispatch claim wins → rejection protected, payout continues through the Moolre lifecycle (10 rounds)', async () => {
        await seedFiatEnv();

        let dispatchWon = 0;
        for (let round = 0; round < 10; round++) {
            const user = await seedUser(prisma, { availableBalance: 500 });
            const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

            // Latch INSIDE the provider call: the dispatch claim and intent
            // evidence are already durable when the dispatcher is invoked.
            const captured = [];
            let release = null;
            const dispatcher = {
                async initiateTransfer(payload) {
                    captured.push(payload);
                    await new Promise((r2) => { release = r2; });
                    return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', _provider: 'moolre', data: { reference: 'moolre_ref' } };
                },
            };
            const controllerDone = callFiatWithdrawal(user.id, dispatcher);

            // Wait until the provider call is latched — claim + evidence are durable.
            while (captured.length === 0) await new Promise((r) => setTimeout(r, 5));
            const reference = captured[0].referenceId;
            const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
            expect(mirror.status).toBe('DISPATCHING'); // the durable claim

            const admin = await seedUser(prisma, { role: 'ADMIN' });
            const res = await reject(admin, mirror.id);
            expect([400, 409]).toContain(res.statusCode); // protected — never a refund
            expect(res.statusCode).not.toBe(200);

            // User NOT refunded, canonical protected.
            const afterAdmin = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(afterAdmin.availableBalance)).toBeLessThan(before);
            const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(canonical.status).toBe('PENDING');

            release();
            const ctrlRes = await controllerDone;
            expect(ctrlRes.statusCode).toBe(200);

            // The payout continued through the normal Moolre lifecycle:
            // exactly one provider call, acceptance evidence recorded.
            expect(captured.length).toBe(1);
            const acceptance = await prisma.fiatProviderEvent.findFirst({
                where: { relatedReference: reference, status: 'PENDING' },
            });
            expect(acceptance).toBeTruthy();
            expect(acceptance.provider).toBe('MOOLRE_DISBURSEMENT');

            // Ownership persisted on the canonical row to the accepting
            // provider (metadata.payoutProvider — r16b ownership surface).
            const owned = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(owned.metadata.payoutProvider).toBe('moolre');
            expect(owned.metadata.payoutProviderName).toBe('MOOLRE_DISBURSEMENT');
            dispatchWon++;
        }
        expect(dispatchWon).toBe(10);
    });

    test('11: r16c — a legacy mirror-only rejection can NEVER consume an unrelated active fiat obligation', async () => {
        await seedFiatEnv();
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const legacyUser = await seedUser(prisma, { availableBalance: 100 });

        // An UNRELATED user holds an active direct-fiat obligation (exactly
        // the shape the old startsWith('withdrawal:fiat:') lookup consumed).
        const otherUser = await seedUser(prisma, { availableBalance: 200 });
        const { reference: otherRef } = await seedCanonicalWithdrawal(otherUser, 50);
        const otherObligationBefore = await prisma.restrictedObligation.findFirst({
            where: { reference: `withdrawal:fiat:${otherRef}`, status: 'ACTIVE' },
        });
        expect(otherObligationBefore).not.toBeNull();

        // A pre-P4 mirror-only legacy withdrawal for the legacy user.
        const legacyRow = await prisma.withdrawal.create({
            data: {
                userId: legacyUser.id,
                amount: 30,
                payoutMethod: 'BINANCE_ID',
                destination: 'OLD_RECORD',
                status: 'PENDING',
            },
        });
        await prisma.user.update({
            where: { id: legacyUser.id },
            data: { availableBalance: { decrement: 30 } },
        });
        const legacyDebited = Number((await prisma.user.findUnique({ where: { id: legacyUser.id } })).availableBalance);

        const res = await reject(admin, legacyRow.id);
        expect(res.statusCode).toBe(200);

        // The legacy user is restored exactly once — from platform equity.
        const legacyAfter = await prisma.user.findUnique({ where: { id: legacyUser.id } });
        expect(Number(legacyAfter.availableBalance)).toBeCloseTo(legacyDebited + 30, 5);

        // The UNRELATED obligation is untouched: still ACTIVE, still held for
        // the other user's payout. Never guess a financial obligation.
        const otherObligationAfter = await prisma.restrictedObligation.findFirst({
            where: { reference: `withdrawal:fiat:${otherRef}`, status: 'ACTIVE' },
        });
        expect(otherObligationAfter).not.toBeNull();
        expect(otherObligationAfter.id).toBe(otherObligationBefore.id);

        // The other user's canonical payout is still protected.
        const otherCanonical = await prisma.transactionHistory.findUnique({ where: { txHash: otherRef } });
        expect(otherCanonical.status).toBe('PENDING');
        const otherMirror = await prisma.withdrawal.findFirst({ where: { userId: otherUser.id } });
        expect(otherMirror.status).toBe('PENDING');
    });

});
