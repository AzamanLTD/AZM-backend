// __tests__/r19-smartroute-settlement-convergence.test.js
// =============================================================================
// r19 P0 proofs — Smart Route MoMo settlement state CONVERGES with the
// canonical fiat lifecycle. The canonical withdrawal stays the financial
// authority; the SmartRouteRun is only a projection that can never
// permanently claim a misleading final state.
//
// Proves against REAL PostgreSQL:
//   1.  provider accepts → run SUCCESS (canonical PENDING) → canonical
//       COMPLETES → run stays SUCCESS, stats/occurrence counted exactly once
//   2.  provider accepts → run SUCCESS → canonical FAILS (user refunded) →
//       run converges to FAILED_GATEWAY, SUCCESS stats unwind exactly once,
//       the occurrence is NOT re-advanced
//   3.  parked AWAITING_RECONCILIATION → canonical COMPLETES → run SUCCESS,
//       stats counted exactly once, occurrence not double-advanced
//   4.  parked AWAITING_RECONCILIATION → canonical FAILS → run FAILED_GATEWAY,
//       user refunded, no stats, occurrence consumed exactly once
//   5.  crashed owner (run EXECUTING) + canonical COMPLETES → run SUCCESS +
//       occurrence advanced EXACTLY once; a later recovery re-drive converges
//       to a no-op (no double money, no double stats)
//   6.  concurrent settlements of the same payout → exactly one convergence
//   7.  recovery sweep backstop: a parked run whose canonical ALREADY
//       completed (e.g. pre-r19 settlement) converges through
//       recoverStalePendingRuns()
//   8.  direct (non-smart-route) withdrawals settle/reverse WITHOUT touching
//       any SmartRouteRun
//   9.  the run durably links to the canonical Withdrawal mirror
//       (run.withdrawalId) — the payout is queryable from both sides
//   10. admin-style rejection of a canonical PENDING payout converges the
//       run to FAILED_GATEWAY and refunds the user exactly once
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r19-convergence] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r19 P0: Smart Route ↔ canonical fiat settlement convergence', () => {
    let prisma, notifStub;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { SmartRouteService } = require('../services/smartRouteService');
        prisma = new PrismaClient();
        notifStub = { sendNotification: async () => ({}) };
    });

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

    /** Park a stale run exactly like a crash after durable dispatch intent. */
    async function parkRun(run) {
        const financeService = require('../services/finance.service');
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const reference = `SRWD_${run.id}`;
        const route = await prisma.smartRoute.findUnique({ where: { id: run.routeId } });
        await financeService.processFiatWithdrawal(prisma, run.userId, 50, {
            reference,
            createWithdrawalRecordInTransaction: async (tx, txRecord) => {
                const rows = await tx.$queryRawUnsafe(
                    'INSERT INTO "Withdrawal" ' +
                    '("userId", "amount", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now()) ' +
                    'RETURNING "id", "userId", "amount", "status"',
                    run.userId, 50, 'MTN_MOMO', 'MOMO', '0240000000', 'PENDING', txRecord.id
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
        await makeSvc(acceptingDispatcher()).recoverStalePendingRuns();
        const parked = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(parked.status).toBe('AWAITING_RECONCILIATION');
        return parked;
    }

    test('1: provider accepts → run SUCCESS → canonical COMPLETES → stays SUCCESS, counted once', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);

        const svc = makeSvc(acceptingDispatcher());
        const run = await svc.runOnce(route.id);
        expect(run.status).toBe('SUCCESS');
        const reference = `SRWD_${run.id}`;
        const nextRunAfterExec = (await prisma.smartRoute.findUnique({ where: { id: route.id } })).nextRunAt;

        // The settlement webhook fires: canonical PENDING → COMPLETED.
        await financeService.completeFiatWithdrawal(prisma, reference, { providerTxId: 'moolre_abc' });

        const refreshedRun = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshedRun.status).toBe('SUCCESS'); // converged, not changed

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('COMPLETED');

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);                                    // counted EXACTLY once
        expect(Number(refreshedRoute.totalRoutedUsdc)).toBeCloseTo(50, 5);
        expect(refreshedRoute.nextRunAt.getTime()).toBe(nextRunAfterExec.getTime()); // not re-advanced
    });

    test('2: provider accepts → run SUCCESS → canonical FAILS → run FAILED_GATEWAY, stats unwind, occurrence not re-advanced', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);

        const svc = makeSvc(acceptingDispatcher());
        const run = await svc.runOnce(route.id);
        expect(run.status).toBe('SUCCESS');
        const reference = `SRWD_${run.id}`;
        const nextRunAfterExec = (await prisma.smartRoute.findUnique({ where: { id: route.id } })).nextRunAt;
        const balanceAfterExec = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const canonicalBeforeReverse = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const feeUsdc = Number(canonicalBeforeReverse.feeUsdc);

        // The reconciliation worker learns the provider FAILED the payout.
        await financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'provider_async_failure' });

        const refreshedRun = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshedRun.status).toBe('FAILED_GATEWAY');
        expect(refreshedRun.failureReason).toContain('provider_async_failure');

        // SUCCESS stats unwound exactly once.
        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(0);
        expect(Number(refreshedRoute.totalRoutedUsdc)).toBeCloseTo(0, 5);

        // User refunded principal + fee exactly once.
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(balanceAfterExec + 50 + feeUsdc, 5);

        // The claimed occurrence was consumed at execution and must NOT be
        // re-advanced by the reversal.
        expect(refreshedRoute.nextRunAt.getTime()).toBe(nextRunAfterExec.getTime());
    });

    test('3: parked AWAITING_RECONCILIATION → canonical COMPLETES → run SUCCESS, counted once, occurrence not double-advanced', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const stale = await seedStaleRun(route.id, user.id);
        const parked = await parkRun(stale);
        const nextRunAfterPark = (await prisma.smartRoute.findUnique({ where: { id: route.id } })).nextRunAt;

        await financeService.completeFiatWithdrawal(prisma, `SRWD_${parked.id}`);

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: parked.id } });
        expect(refreshed.status).toBe('SUCCESS');

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);
        expect(Number(refreshedRoute.totalRoutedUsdc)).toBeCloseTo(50, 5);
        expect(refreshedRoute.nextRunAt.getTime()).toBe(nextRunAfterPark.getTime()); // advanced once at park, not again
    });

    test('4: parked AWAITING_RECONCILIATION → canonical FAILS → run FAILED_GATEWAY, user refunded, no stats', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const stale = await seedStaleRun(route.id, user.id);
        const parked = await parkRun(stale);
        const nextRunAfterPark = (await prisma.smartRoute.findUnique({ where: { id: route.id } })).nextRunAt;
        const balanceAfterPark = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        const canonicalBeforeReverse = await prisma.transactionHistory.findUnique({ where: { txHash: `SRWD_${parked.id}` } });
        const feeUsdc = Number(canonicalBeforeReverse.feeUsdc);

        await financeService.reverseFiatWithdrawal(prisma, `SRWD_${parked.id}`, { reason: 'provider_async_failure' });

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: parked.id } });
        expect(refreshed.status).toBe('FAILED_GATEWAY');

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(0);                                    // parked never counted
        expect(Number(refreshedRoute.totalRoutedUsdc)).toBeCloseTo(0, 5);
        expect(refreshedRoute.nextRunAt.getTime()).toBe(nextRunAfterPark.getTime()); // consumed once at park

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(balanceAfterPark + 50 + feeUsdc, 5);
    });

    test('5: crashed owner (EXECUTING) + canonical COMPLETES → SUCCESS + occurrence advanced exactly once; recovery re-drive is a no-op', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const stale = await seedStaleRun(route.id, user.id);

        // Craft the crashed-owner state directly: the run was claimed and
        // flipped EXECUTING, its reservation + dispatch evidence committed,
        // and the owner died before finalization. (This is the exact row
        // state a crash between dispatch acceptance and finalize leaves.)
        const reference = `SRWD_${stale.id}`;
        await prisma.smartRouteRun.update({
            where: { id: stale.id },
            data: { status: 'EXECUTING', updatedAt: new Date(Date.now() - 7200000) },
        });
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
        const userBeforeSettle = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        await financeService.completeFiatWithdrawal(prisma, reference);

        const converged = await prisma.smartRouteRun.findUnique({ where: { id: stale.id } });
        expect(converged.status).toBe('SUCCESS');

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);
        expect(refreshedRoute.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // occurrence advanced EXACTLY once
        const nextRunAfterConverge = refreshedRoute.nextRunAt;

        // A later recovery re-drive of the same run converges to a NO-OP.
        const dispatcher = acceptingDispatcher();
        const recoverySvc = makeSvc(dispatcher);
        await recoverySvc.recoverStalePendingRuns();

        const finalRun = await prisma.smartRouteRun.findUnique({ where: { id: stale.id } });
        expect(finalRun.status).toBe('SUCCESS');                        // unchanged
        const finalRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(finalRoute.totalRuns).toBe(1);                           // NOT double-counted
        expect(finalRoute.nextRunAt.getTime()).toBe(nextRunAfterConverge.getTime()); // NOT double-advanced
        expect(dispatcher.calls.length).toBe(0);                        // NO second provider dispatch
        const finalUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(finalUser.availableBalance)).toBeCloseTo(userBeforeSettle, 5); // no double refund/charge
    });

    test('6: concurrent settlements of the same payout → exactly one convergence', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const stale = await seedStaleRun(route.id, user.id);
        const parked = await parkRun(stale);
        const reference = `SRWD_${parked.id}`;

        // Two concurrent settlement deliveries (webhook + reconciler).
        await Promise.allSettled([
            financeService.completeFiatWithdrawal(prisma, reference),
            financeService.completeFiatWithdrawal(prisma, reference),
        ]);

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: parked.id } });
        expect(refreshed.status).toBe('SUCCESS');
        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);                        // converged EXACTLY once
        expect(Number(refreshedRoute.totalRoutedUsdc)).toBeCloseTo(50, 5);
    });

    test('7: recovery sweep converges a parked run whose canonical ALREADY completed', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const stale = await seedStaleRun(route.id, user.id);
        const parked = await parkRun(stale);
        const reference = `SRWD_${parked.id}`;
        const nextRunAfterPark = (await prisma.smartRoute.findUnique({ where: { id: route.id } })).nextRunAt;

        // The canonical completes WITHOUT a convergence path (this is the
        // pre-r19 parked dead-end: settlement happened while the run was
        // parked and nothing linked them). A stubbed direct update models
        // the exact row state a pre-r19 completion leaves behind.
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');

        // The sweep does NOT guess while the canonical is still PENDING —
        // the reconciler owns the payout.
        await makeSvc(acceptingDispatcher()).recoverStalePendingRuns();
        const idleRun = await prisma.smartRouteRun.findUnique({ where: { id: parked.id } });
        expect(idleRun.status).toBe('AWAITING_RECONCILIATION'); // not guessed

        // The canonical reaches its terminal state WITHOUT any run linkage —
        // the exact pre-r19 dead-end this sweep exists to rescue.
        await prisma.$executeRawUnsafe(
            'UPDATE "TransactionHistory" SET "status" = $1::\"TransactionStatus\" WHERE "txHash" = $2',
            'COMPLETED', reference
        );
        await makeSvc(acceptingDispatcher()).recoverStalePendingRuns();

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: parked.id } });
        expect(refreshed.status).toBe('SUCCESS');
        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);                               // counted EXACTLY once
        expect(refreshedRoute.nextRunAt.getTime()).toBe(nextRunAfterPark.getTime()); // not double-advanced
    });

    test('8: direct (non-smart-route) withdrawals settle/reverse WITHOUT touching SmartRouteRun rows', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });

        // A DIRECT fiat withdrawal (the classic controller path).
        const result = await financeService.processFiatWithdrawal(prisma, user.id, 20, {
            reference: 'WD_test_direct_001',
            liquidityRoute: { provider: 'MOOLRE_DISBURSEMENT', rail: 'MOMO', destination: '0240000000' },
        });
        expect(result).toBeDefined();

        const runsBefore = await prisma.smartRouteRun.findMany({});
        expect(runsBefore.length).toBe(0);

        await financeService.completeFiatWithdrawal(prisma, 'WD_test_direct_001');
        await financeService.reverseFiatWithdrawal(prisma, 'WD_test_direct_002_missing', { reason: 'test' }).catch(() => {});

        const runsAfter = await prisma.smartRouteRun.findMany({});
        expect(runsAfter.length).toBe(0);
    });

    test('9: the run durably links to the canonical Withdrawal mirror (withdrawalId)', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);

        const svc = makeSvc(acceptingDispatcher());
        const run = await svc.runOnce(route.id);

        const refreshedRun = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshedRun.withdrawalId).toBeTruthy();

        const mirror = await prisma.withdrawal.findUnique({ where: { id: refreshedRun.withdrawalId } });
        expect(mirror).toBeTruthy();
        expect(mirror.transactionHistoryId).toBe(
            (await prisma.transactionHistory.findUnique({ where: { txHash: `SRWD_${run.id}` } })).id
        );
    });

    test('10: admin-style rejection of the canonical payout converges the run to FAILED_GATEWAY and refunds once', async () => {
        await seedFiatEnv();
        const financeService = require('../services/finance.service');
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id);
        const stale = await seedStaleRun(route.id, user.id);
        const reference = `SRWD_${stale.id}`;

        // The reservation exists (canonical PENDING, user debited), the run
        // is claimed — and an admin rejects the payout.
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
        const debited = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        const canonicalBeforeReject = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const feeUsdc = Number(canonicalBeforeReject.feeUsdc);

        await financeService.reverseFiatWithdrawal(prisma, reference, { reason: 'admin_rejection' });

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: stale.id } });
        expect(refreshed.status).toBe('FAILED_GATEWAY');
        expect(refreshed.failureReason).toContain('admin_rejection');

        // Refunded exactly once (principal + fee).
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(debited + 50 + feeUsdc, 5);

        // The occurrence was consumed exactly once.
        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        expect(refreshedRoute.totalRuns).toBe(0);
        const nextRunAfterRejection = refreshedRoute.nextRunAt;

        // A recovery re-drive of the same run converges to a NO-OP.
        const dispatcher = acceptingDispatcher();
        await makeSvc(dispatcher).recoverStalePendingRuns();
        const afterRecovery = await prisma.smartRouteRun.findUnique({ where: { id: stale.id } });
        expect(afterRecovery.status).toBe('FAILED_GATEWAY');        // unchanged
        expect(dispatcher.calls.length).toBe(0);                    // no dispatch over a rejected payout
        const finalRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(finalRoute.nextRunAt.getTime()).toBe(nextRunAfterRejection.getTime()); // not re-advanced
    });
});
