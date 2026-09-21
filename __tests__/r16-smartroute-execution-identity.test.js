// __tests__/r16-smartroute-execution-identity.test.js
// =============================================================================
// r16 P0-A proofs — Smart Route execution identity / double-execution race.
//
// Proves against REAL PostgreSQL:
//   1. scheduled run vs scheduled run        → exactly ONE SUCCESS run, money moved once
//   2. scheduled run vs manual run-now       → the due occurrence is consumed once
//   3. manual run-now vs manual run-now      → both allowed (distinct identities), each moves money once
//   4. crash/recovery after execution claim  → stale PENDING run re-driven exactly once
//   5. successful execution increments totalRuns EXACTLY once
//   6. failed execution consumes the occurrence exactly once (no double retry)
//   7. Smart Route MoMo enters the canonical withdrawal pipeline (r16 P0-B)
//
// r16c P0-B — honest MoMo execution-identity state machine, real PostgreSQL:
//   8.  crash after execution claim, before financial reservation → reserve
//       exactly once on recovery
//   9.  crash after canonical reservation, before dispatch → resume dispatch
//       with the ORIGINALLY reserved GHS, provider called exactly once
//   10. crash after DISPATCH_INTENT, before provider I/O → park
//       AWAITING_RECONCILIATION, provider NEVER called, no refund
//   11. provider accepted, process died before finalization → park, never
//       re-dispatch blindly
//   12. synchronous provider rejection (NOT_DISPATCHED) → reversal exactly
//       once, run FAILED_GATEWAY, occurrence consumed once
//   13. dispatcher unavailable → reservation reversed, run FAILED_OTHER —
//       never SUCCESS over an undispatched payout
//   14. concurrent recovery of the same stale run → exactly one execution
//   15. concurrent scheduled executions of a MoMo route → one SUCCESS run,
//       one canonical reservation, one provider call, totalRuns = 1
//   16. canonical fiat TransactionHistory stays PENDING until the actual
//       provider outcome (SUCCESS never means "reservation exists")
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r16-smartroute] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r16 P0-A: Smart Route execution identity', () => {
    let prisma, svc, notifStub;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { SmartRouteService } = require('../services/smartRouteService');
        prisma = new PrismaClient();
        notifStub = { sendNotification: async () => ({}) };
        svc = new SmartRouteService({
            prisma,
            io: null,
            notificationService: notifStub,
            mtnDisbursementService: null,
            vaultService: null,
        });
    });

    /** r16c: service with an injected dispatcher for MoMo dispatch tests. */
    function makeSvc(dispatcher) {
        const { SmartRouteService } = require('../services/smartRouteService');
        return new SmartRouteService({
            prisma,
            io: null,
            notificationService: notifStub,
            mtnDisbursementService: dispatcher,
            vaultService: null,
        });
    }

    /** Accepting fake dispatcher with a call recorder. */
    function acceptingDispatcher() {
        const calls = [];
        return {
            calls,
            async initiateTransfer(payload) {
                calls.push(payload);
                return {
                    status: 'PENDING',
                    provider: 'MOOLRE_DISBURSEMENT',
                    _provider: 'moolre',
                    data: { reference: `moolre_${payload.referenceId}` },
                };
            },
        };
    }

    /** Fake dispatcher whose provider call throws the given outcome. */
    function rejectingDispatcher(outcome) {
        const calls = [];
        return {
            calls,
            async initiateTransfer(payload) {
                calls.push(payload);
                const err = new Error(`fake ${outcome}`);
                err.providerOutcome = outcome;
                throw err;
            },
        };
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

    async function seedMomoRoute(userId, overrides = {}) {
        const past = new Date(Date.now() - 60 * 60 * 1000);
        return prisma.smartRoute.create({
            data: {
                userId,
                name: 'MoMo payout',
                action: 'WITHDRAW_MOMO',
                amountUsdc: 50,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destMomoNumber: '0240000000',
                destMomoProvider: 'MTN_MOMO',
                ...overrides,
            },
        });
    }

    /** Seed a stale PENDING run exactly like a crashed execution leaves it. */
    async function seedStaleRun(routeId, userId, opts = {}) {
        const created = new Date(Date.now() - (opts.staleMs || (6 * 60 * 60 * 1000)) - 1000);
        return prisma.smartRouteRun.create({
            data: {
                routeId,
                userId,
                status: 'PENDING',
                amountUsdc: 50,
                executionKey: opts.executionKey || `${routeId}:occ:${new Date(Date.now() - 60 * 60 * 1000).toISOString()}`,
                createdAt: created,
            },
        });
    }

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "SavingsGoal", "SavingsDeposit", "Vault", "VaultDeposit", "GlobalSettings", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "Withdrawal", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

    async function seedRoute(userId, overrides = {}) {
        const past = new Date(Date.now() - 60 * 60 * 1000); // due now
        return prisma.smartRoute.create({
            data: {
                userId,
                name: 'Test route',
                action: 'INTERNAL_TRANSFER',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destFriendUserId: overrides.destFriendUserId,
                ...overrides,
            },
        });
    }

    test('1: two concurrent scheduled executions of one due occurrence → exactly one SUCCESS run, one debit', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        const route = await seedRoute(user.id, { destFriendUserId: friend.id });

        const [, r1, r2] = await Promise.allSettled([
            Promise.resolve(),
            svc.runOnce(route.id),
            svc.runOnce(route.id),
        ]);
        expect(r1.status).toBe('fulfilled');
        expect(r2.status).toBe('fulfilled');

        const runs = await prisma.smartRouteRun.findMany({ where: { routeId: route.id } });
        const successRuns = runs.filter((r) => r.status === 'SUCCESS');
        expect(successRuns.length).toBe(1);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(490, 5);
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(10, 5);

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);
        expect(refreshedRoute.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // occurrence consumed
    });

    test('2: scheduled worker + concurrent manual run-now consume the same due occurrence exactly once', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        const route = await seedRoute(user.id, { destFriendUserId: friend.id });

        const [m1, m2] = await Promise.all([
            svc.runOnce(route.id),
            svc.runOnce(route.id, { manual: true }),
        ]);
        // Exactly one execution may win; the skipped claim reports it.
        const outcomes = [m1, m2];
        const successes = outcomes.filter((o) => o && !o.skipped);
        expect(successes.length).toBe(1);

        const runs = await prisma.smartRouteRun.findMany({ where: { routeId: route.id } });
        expect(runs.filter((r) => r.status === 'SUCCESS').length).toBe(1);

        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(10, 5);
    });

    test('3: two manual run-now calls with NOTHING due → two distinct manual identities, both execute', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        const future = new Date(Date.now() + 7 * 86400000); // not due
        const route = await seedRoute(user.id, { destFriendUserId: friend.id, nextRunAt: future });

        const [m1, m2] = await Promise.all([
            svc.runOnce(route.id, { manual: true }),
            svc.runOnce(route.id, { manual: true }),
        ]);
        expect(m1.skipped).toBeFalsy();
        expect(m2.skipped).toBeFalsy();
        expect(m1.id).not.toBe(m2.id);

        const runs = await prisma.smartRouteRun.findMany({ where: { routeId: route.id } });
        expect(runs.filter((r) => r.status === 'SUCCESS').length).toBe(2);

        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(20, 5);

        // A manual run while nothing is due must NOT have consumed the scheduled occurrence.
        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.nextRunAt.getTime()).toBe(future.getTime());
    });

    test('4: crash after execution claim → stale PENDING run is recovered exactly once', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        const route = await seedRoute(user.id, { destFriendUserId: friend.id });

        // Simulate a crash between claim and execution: a PENDING run older
        // than the stale window whose money transaction never committed.
        const staleCreatedAt = new Date(Date.now() - 30 * 60 * 1000);
        const crashed = await prisma.smartRouteRun.create({
            data: {
                routeId: route.id,
                userId: user.id,
                status: 'PENDING',
                amountUsdc: 10,
                executionKey: `${route.id}:occ:${route.nextRunAt.toISOString()}`,
                createdAt: staleCreatedAt,
            },
        });

        const recovered = await svc.recoverStalePendingRuns();
        expect(recovered.length).toBe(1);

        // A concurrent scheduler tick racing the recovery must NOT duplicate.
        await svc.runOnce(route.id);
        const runs = await prisma.smartRouteRun.findMany({ where: { routeId: route.id } });
        expect(runs.filter((r) => r.status === 'SUCCESS').length).toBe(1);
        expect(runs.find((r) => r.id === crashed.id).status).toBe('SUCCESS');

        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(10, 5);
    });

    test('5+6: successful execution increments totalRuns exactly once; failed execution consumes the occurrence once', async () => {
        const rich = await seedUser(prisma, { availableBalance: 500 });
        const poor = await seedUser(prisma, { availableBalance: 1 }); // < route amount
        const friend = await seedUser(prisma, { availableBalance: 0 });
        const route = await seedRoute(poor.id, { destFriendUserId: friend.id });

        // Failed execution (insufficient balance)
        const failed = await svc.runOnce(route.id);
        expect(failed.status).toBe('FAILED_INSUFFICIENT');

        const refreshed = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshed.totalRuns).toBe(0); // failures never inflate the counter
        expect(refreshed.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // occurrence consumed — no infinite retry

        // The next occurrence succeeds and increments exactly once.
        const dueNow = new Date(Date.now() - 1000);
        await prisma.smartRoute.update({ where: { id: route.id }, data: { nextRunAt: dueNow } });
        await prisma.user.update({ where: { id: poor.id }, data: { availableBalance: 50 } });

        const ok = await svc.runOnce(route.id);
        expect(ok.status).toBe('SUCCESS');

        const finalRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(finalRoute.totalRuns).toBe(1);
        const finalFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(finalFriend.availableBalance)).toBeCloseTo(10, 5);
        expect(rich).toBeDefined();
    });

    test('7: P0-B — Smart Route MoMo enters the canonical withdrawal pipeline', async () => {
        await seedFiatEnv();

        // r16c: a null dispatcher would now reverse the reservation and fail
        // the run (test 13). Use an accepting fake so SUCCESS is honest.
        const fake = acceptingDispatcher();
        const momoSvc = makeSvc(fake);
        const user = await seedUser(prisma, { availableBalance: 200 });
        const past = new Date(Date.now() - 60 * 60 * 1000);
        const route = await prisma.smartRoute.create({
            data: {
                userId: user.id,
                name: 'MoMo payout',
                action: 'WITHDRAW_MOMO',
                amountUsdc: 50,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destMomoNumber: '0240000000',
                destMomoProvider: 'MTN_MOMO',
            },
        });

        const run = await momoSvc.runOnce(route.id);
        expect(run.status).toBe('SUCCESS');
        expect(fake.calls.length).toBe(1);

        // Canonical TransactionHistory: WITHDRAWAL_FIAT, PENDING until provider outcome.
        const canonical = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' },
        });
        expect(canonical).not.toBeNull();
        expect(canonical.status).toBe('PENDING');
        expect(canonical.txHash).toBe(`SRWD_${run.id}`);

        // The Withdrawal mirror is durably linked via the transactionHistoryId bridge.
        const withdrawal = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(withdrawal).not.toBeNull();
        const bridge = await prisma.$queryRawUnsafe(
            'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "id" = $1 LIMIT 1', withdrawal.id
        );
        expect(bridge[0].transactionHistoryId).toBe(canonical.id);

        // No SMART_ROUTE_RUN history row masquerading as a completed payout.
        const smartRunHistory = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'SMART_ROUTE_RUN' },
        });
        expect(smartRunHistory).toBeNull();

        // Restricted obligation keyed to the canonical pipeline reference.
        const obligation = await prisma.restrictedObligation.findFirst({
            where: { reference: `withdrawal:fiat:SRWD_${run.id}` },
        });
        expect(obligation).not.toBeNull();
        expect(obligation.status).toBe('ACTIVE');

        // User debited exactly once (amount + exit fee).
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeLessThan(150);
        expect(Number(fresh.availableBalance)).toBeGreaterThan(140);
    });

    // ── r16c P0-B: honest dispatch-state / crash-recovery matrix ────────────

    test('8: crash after execution claim, before financial reservation → recovery reserves exactly once', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);

        const fake = acceptingDispatcher();
        const momoSvc = makeSvc(fake);
        const outcomes = await momoSvc.recoverStalePendingRuns();
        expect(outcomes.length).toBe(1);

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('SUCCESS');

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: `SRWD_${run.id}` } });
        expect(canonical).not.toBeNull();
        expect(canonical.status).toBe('PENDING'); // settlement still owned by the provider

        const count = await prisma.transactionHistory.count({ where: { type: 'WITHDRAWAL_FIAT', userId: user.id } });
        expect(count).toBe(1);
        expect(fake.calls.length).toBe(1);

        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.totalRuns).toBe(1);
    });

    test('9: crash after canonical reservation, before dispatch → resume dispatch with the originally reserved GHS', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);

        // Simulate the crashed execution: canonical reservation committed,
        // dispatch never started. Same in-transaction mirror bridge as the
        // real executor.
        const financeService = require('../services/finance.service');
        const reference = `SRWD_${run.id}`;
        await financeService.processFiatWithdrawal(prisma, user.id, 50, {
            reference,
            createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                const rows = await tx.$queryRawUnsafe(
                    'INSERT INTO "Withdrawal" ' +
                    '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                    'RETURNING "id", "userId", "amount", "status"',
                    user.id, 50, 'MTN_MOMO', 'MOMO', '0240000000', 'PENDING', txRecord.id
                );
                return rows?.[0] || null;
            },
        });
        const afterCrash = await prisma.user.findUnique({ where: { id: user.id } });
        const debitedOnce = Number(afterCrash.availableBalance);

        // Rate drift AFTER the crash — the resume must send the ORIGINALLY
        // reserved GHS (P5-D), never recompute the payout.
        await prisma.globalSettings.update({ where: { id: 1 }, data: { liveRetailRate: 99, liveUsdToGhs: 99 } });

        const fake = acceptingDispatcher();
        const momoSvc = makeSvc(fake);
        await momoSvc.recoverStalePendingRuns();

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('SUCCESS');
        expect(fake.calls.length).toBe(1);
        expect(Number(fake.calls[0].amountGhs)).toBeCloseTo(750, 1); // 50 USDC @ 15 — the reserved rate

        // No re-reservation: exactly one debit.
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(debitedOnce, 5);
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');
    });

    test('10: crash after DISPATCH_INTENT, before provider I/O → park, never call the provider, never refund', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);

        const financeService = require('../services/finance.service');
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const reference = `SRWD_${run.id}`;
        await financeService.processFiatWithdrawal(prisma, user.id, 50, {
            reference,
            createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                const rows = await tx.$queryRawUnsafe(
                    'INSERT INTO "Withdrawal" ' +
                    '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                    'RETURNING "id", "userId", "amount", "status"',
                    user.id, 50, 'MTN_MOMO', 'MOMO', '0240000000', 'PENDING', txRecord.id
                );
                return rows?.[0] || null;
            },
        });
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'AZM_DISPATCHER',
            rail: 'MOMO',
            direction: 'OUTBOUND',
            status: 'DISPATCH_INTENT',
            dedupKey: `event:payout-dispatch-intent:${reference}`,
            relatedReference: reference,
            raw: { externalId: reference, stage: 'PRE_PROVIDER_IO', source: 'smart_route' },
        });
        const afterCrash = await prisma.user.findUnique({ where: { id: user.id } });
        const debited = Number(afterCrash.availableBalance);

        const fake = acceptingDispatcher();
        const momoSvc = makeSvc(fake);
        await momoSvc.recoverStalePendingRuns();

        // Parked — the payout may be in flight, recovery must not guess.
        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('AWAITING_RECONCILIATION');
        expect(fake.calls.length).toBe(0); // NEVER a second provider call

        // Protected: not refunded, canonical stays PENDING.
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(debited, 5);

        // A loud reconciliation exception is open for the payout (raw-SQL
        // table — no Prisma model).
        const exc = await prisma.$queryRawUnsafe(
            'SELECT "status" FROM "ReconciliationException" WHERE "reference" = $1 ORDER BY "id" DESC LIMIT 1', reference
        );
        expect(exc.length).toBe(1);
        expect(exc[0].status).toBe('OPEN');

        // The occurrence is consumed — no infinite recovery loop.
        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.totalRuns).toBe(0); // SUCCESS-only counter
    });

    test('11: provider accepted, process died before finalization → park, never re-dispatch blindly', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);

        // Crashed state: reservation + intent + ACCEPTED dispatch evidence.
        const financeService = require('../services/finance.service');
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const reference = `SRWD_${run.id}`;
        await financeService.processFiatWithdrawal(prisma, user.id, 50, {
            reference,
            createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                const rows = await tx.$queryRawUnsafe(
                    'INSERT INTO "Withdrawal" ' +
                    '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                    'RETURNING "id", "userId", "amount", "status"',
                    user.id, 50, 'MTN_MOMO', 'MOMO', '0240000000', 'PENDING', txRecord.id
                );
                return rows?.[0] || null;
            },
        });
        for (const ev of [
            { status: 'DISPATCH_INTENT', dedupKey: `event:payout-dispatch-intent:${reference}` },
            { status: 'PENDING', dedupKey: `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}`, provider: 'MOOLRE_DISBURSEMENT' },
        ]) {
            await fiatLiquidity.recordProviderEvent(prisma, {
                provider: ev.provider || 'AZM_DISPATCHER',
                rail: 'MOMO',
                direction: 'OUTBOUND',
                status: ev.status,
                dedupKey: ev.dedupKey,
                relatedReference: reference,
                raw: { externalId: reference, source: 'smart_route' },
            });
        }

        const fake = acceptingDispatcher();
        const momoSvc = makeSvc(fake);
        await momoSvc.recoverStalePendingRuns();

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('AWAITING_RECONCILIATION');
        expect(fake.calls.length).toBe(0); // the payout was already dispatched — never again

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING'); // reconciliation owns settlement
        const exc = await prisma.$queryRawUnsafe(
            'SELECT "status" FROM "ReconciliationException" WHERE "reference" = $1 ORDER BY "id" DESC LIMIT 1', reference
        );
        expect(exc.length).toBe(1);
        expect(exc[0].status).toBe('OPEN');
    });

    test('12: synchronous provider rejection (NOT_DISPATCHED) → reversal exactly once, FAILED_GATEWAY, occurrence consumed once', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);
        const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const fake = rejectingDispatcher('NOT_DISPATCHED');
        const momoSvc = makeSvc(fake);
        await momoSvc.recoverStalePendingRuns();

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('FAILED_GATEWAY');
        expect(fake.calls.length).toBe(1);

        const reference = `SRWD_${run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED'); // reversed exactly once

        // User restored exactly once: amount + exit fee.
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(before, 5);

        // Exactly one reversal ledger post for the reference.
        const reversals = await prisma.ledgerTransaction.findMany({
            where: { idempotencyKey: `ledger:withdrawal:fiat:reverse:${reference}` },
        });
        expect(reversals.length).toBe(1);

        // Occurrence consumed exactly once — no duplicate retry.
        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        expect(freshRoute.totalRuns).toBe(0);
    });

    test('13: dispatcher unavailable → reservation reversed, run FAILED_OTHER — never SUCCESS over an undispatched payout', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);
        const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        // No dispatcher bound — deterministic pre-I/O failure.
        await svc.recoverStalePendingRuns();

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('FAILED_OTHER');
        expect(refreshed.failureReason).toContain('dispatcher unavailable');

        const reference = `SRWD_${run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED'); // reservation unwound, not parked

        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(before, 5); // fully restored
        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.totalRuns).toBe(0);
    });

    test('14: concurrent recovery of the same stale run → exactly one execution', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        await seedStaleRun(route.id, user.id);

        const fake = acceptingDispatcher();
        const a = makeSvc(fake);
        const b = makeSvc(fake);
        const [, ra, rb] = await Promise.allSettled([
            Promise.resolve(),
            a.recoverStalePendingRuns(),
            b.recoverStalePendingRuns(),
        ]);
        expect(ra.status).toBe('fulfilled');
        expect(rb.status).toBe('fulfilled');

        const runs = await prisma.smartRouteRun.findMany({ where: { routeId: route.id } });
        expect(runs.filter((r) => r.status === 'SUCCESS').length).toBe(1);
        expect(fake.calls.length).toBe(1); // one dispatch, not two

        const canonicalCount = await prisma.transactionHistory.count({ where: { type: 'WITHDRAWAL_FIAT', userId: user.id } });
        expect(canonicalCount).toBe(1);
        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.totalRuns).toBe(1);
    });

    test('15: concurrent scheduled executions of a MoMo route → one SUCCESS run, one reservation, one provider call, totalRuns = 1', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);

        const fake = acceptingDispatcher();
        const a = makeSvc(fake);
        const b = makeSvc(fake);
        const [, ra, rb] = await Promise.allSettled([
            Promise.resolve(),
            a.runOnce(route.id),
            b.runOnce(route.id),
        ]);
        expect(ra.status).toBe('fulfilled');
        expect(rb.status).toBe('fulfilled');

        const runs = await prisma.smartRouteRun.findMany({ where: { routeId: route.id } });
        const successRuns = runs.filter((r) => r.status === 'SUCCESS');
        expect(successRuns.length).toBe(1);
        expect(fake.calls.length).toBe(1);

        // Money reserved exactly once: one canonical row, one mirror.
        const canonicalCount = await prisma.transactionHistory.count({ where: { type: 'WITHDRAWAL_FIAT', userId: user.id } });
        expect(canonicalCount).toBe(1);
        const mirrorCount = await prisma.withdrawal.count({ where: { userId: user.id } });
        expect(mirrorCount).toBe(1);

        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.totalRuns).toBe(1);
    });

    test('16: canonical fiat stays PENDING until the provider outcome — SUCCESS never means "reservation exists"', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const run = await seedStaleRun(route.id, user.id);

        // Provider accepted, but settlement has NOT been observed yet.
        const fake = acceptingDispatcher();
        const momoSvc = makeSvc(fake);
        await momoSvc.recoverStalePendingRuns();

        const reference = `SRWD_${run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('SUCCESS'); // provider ACCEPTED — the honest success
        expect(refreshed.withdrawalId).not.toBeNull();
        expect(Number(refreshed.amountGhs)).toBeCloseTo(750, 1);
        expect(Number(refreshed.rateUsed)).toBeCloseTo(15, 5);

        // The run never consumed the occurrence twice, and the mirror is
        // claimed by the dispatch (protected from admin rejection).
        const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(mirror.status).toBe('DISPATCHING');
    });

});
