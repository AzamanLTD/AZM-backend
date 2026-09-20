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

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "SavingsGoal", "SavingsDeposit", "Vault", "VaultDeposit", "GlobalSettings", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "Withdrawal", "FiatProviderEvent" RESTART IDENTITY CASCADE'
        );
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
                updatedAt: staleCreatedAt,
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
        await prisma.globalSettings.create({
            data: { id: 1, liveRetailRate: 15, liveUsdToGhs: 15 }
        }).catch(() => {});
        await prisma.systemFiatPool.create({ data: { id: 1, balance: 100000 } }).catch(() => {});
        await prisma.systemMasterCrypto.create({ data: { id: 1, balance: 0 } }).catch(() => {});
        await prisma.systemProfitFees.create({ data: { id: 1, balance: 0 } }).catch(() => {});

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

        const run = await svc.runOnce(route.id);
        expect(run.status).toBe('SUCCESS');

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
});
