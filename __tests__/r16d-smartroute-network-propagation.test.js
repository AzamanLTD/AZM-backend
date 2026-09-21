// __tests__/r16d-smartroute-network-propagation.test.js
// =============================================================================
// r16d P0 proofs — Smart Route MoMo destination-network propagation.
//
// The Flutter Smart Route UI sends the chosen network (MTN / VODAFONE /
// TELECEL) as destination.momoProvider; the backend persists it (legacy
// misnamed) in SmartRoute.destMomoProvider. Before r16d the Moolre dispatch
// payload omitted `network`, so Moolre defaulted EVERY Smart Route payout to
// the MTN channel — a scheduled Telecel payout silently arrived as MTN.
//
// Proves against REAL PostgreSQL:
//   1. a TELECEL route dispatches with network "TELECEL" and the Withdrawal
//      mirror records network "TELECEL"
//   2. an AIRTELTIGO route dispatches with network "AIRTELTIGO"
//   3. legacy VODAFONE canonicalizes to TELECEL at create/update boundaries
//   4. legacy MTN_MOMO canonicalizes to MTN at dispatch
//   5. an invalid network fails closed BEFORE the execution lease and any
//      provider I/O — no reservation, no provider call, honest FAILED_OTHER
//   6. an invalid/ambiguous network is rejected at the CRUD boundary
//   7. crash/recovery after reservation re-derives the SAME canonical network
//      (never a default or a different value)
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r16d-smartroute] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r16d P0: Smart Route MoMo network propagation', () => {
    let prisma, notifStub;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        notifStub = { sendNotification: async () => ({}) };
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "SavingsGoal", "SavingsDeposit", "Vault", "VaultDeposit", "GlobalSettings", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "Withdrawal", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

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
                destMomoNumber: '0200000000',
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

    test('1: TELECEL route dispatches with network "TELECEL" and mirrors network on the Withdrawal record', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id, { destMomoProvider: 'TELECEL' });
        const run = await seedStaleRun(route.id, user.id);

        const fake = acceptingDispatcher();
        await makeSvc(fake).recoverStalePendingRuns();

        expect(fake.calls.length).toBe(1);
        expect(fake.calls[0].network).toBe('TELECEL'); // never omitted, never defaulted

        const reference = `SRWD_${run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        expect(mirror.network).toBe('TELECEL');
        expect(mirror.payoutMethod).toBe('MTN_MOMO'); // legacy discovery discriminator
    });

    test('2: AIRTELTIGO route dispatches with network "AIRTELTIGO"', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id, { destMomoProvider: 'AIRTELTIGO' });
        await seedStaleRun(route.id, user.id);

        const fake = acceptingDispatcher();
        await makeSvc(fake).recoverStalePendingRuns();

        expect(fake.calls.length).toBe(1);
        expect(fake.calls[0].network).toBe('AIRTELTIGO');
    });

    test('3: legacy VODAFONE canonicalizes to TELECEL at create and update', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const svc = makeSvc(acceptingDispatcher());

        const route = await svc.create({
            userId: user.id,
            name: 'Telecel route',
            action: 'WITHDRAW_MOMO',
            amountUsdc: 10,
            frequency: 'WEEKLY',
            startDate: new Date(Date.now() - 7 * 86400000),
            destination: { momoNumber: '0200000000', momoProvider: 'VODAFONE' },
        });
        expect(route.destMomoProvider).toBe('TELECEL'); // persisted canonical

        const updated = await svc.update(user.id, route.id, {
            destination: { momoProvider: 'VODAFONE_CASH' },
        });
        expect(updated.destMomoProvider).toBe('TELECEL');
    });

    test('4: legacy MTN_MOMO row dispatches with network "MTN"', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedMomoRoute(user.id, { destMomoProvider: 'MTN_MOMO' }); // legacy row
        await seedStaleRun(route.id, user.id);

        const fake = acceptingDispatcher();
        await makeSvc(fake).recoverStalePendingRuns();

        expect(fake.calls.length).toBe(1);
        expect(fake.calls[0].network).toBe('MTN'); // canonical, not the raw legacy string
    });

    test('5: invalid persisted network fails closed before the lease, reservation and provider I/O', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const before = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        const route = await seedMomoRoute(user.id, { destMomoProvider: 'BOGUS_NET' });
        const run = await seedStaleRun(route.id, user.id);

        const fake = acceptingDispatcher();
        await makeSvc(fake).recoverStalePendingRuns();

        // Provider never contacted.
        expect(fake.calls.length).toBe(0);

        // No canonical reservation — money untouched.
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: `SRWD_${run.id}` } });
        expect(canonical).toBeNull();
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(before, 5);

        // The run failed honestly with durable evidence.
        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('FAILED_OTHER');
        const exc = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ReconciliationException" WHERE "reason" = $1',
            'SMART_ROUTE_INVALID_MOMO_NETWORK'
        );
        expect(exc[0].n).toBe(1);
    });

    test('6: ambiguous/unknown networks are rejected at the CRUD boundary', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const svc = makeSvc(acceptingDispatcher());
        const base = {
            userId: user.id,
            name: 'x',
            action: 'WITHDRAW_MOMO',
            amountUsdc: 10,
            frequency: 'WEEKLY',
            startDate: new Date(Date.now() - 7 * 86400000),
        };

        for (const bad of ['MOMO', 'WHATEVER']) {
            await expect(
                svc.create({ ...base, destination: { momoNumber: '0200000000', momoProvider: bad } })
            ).rejects.toMatchObject({ code: 'SMART_ROUTE_INVALID_MOMO_NETWORK' });
        }
        await expect(
            svc.create({ ...base, destination: { momoNumber: '0200000000' } })
        ).rejects.toThrow(/momoProvider/); // still required at the boundary
    });

    test('7: crash after reservation, before dispatch → recovery re-derives the SAME canonical network', async () => {
        await seedFiatEnv();
        const user = await seedUser(prisma, { availableBalance: 500 });
        // Legacy row value — recovery must canonicalize identically, never default.
        const route = await seedMomoRoute(user.id, { destMomoProvider: 'VODAFONE' });
        const run = await seedStaleRun(route.id, user.id);

        // Crash state: canonical reservation + mirror exist, NO dispatch evidence.
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
                    user.id, 50, 'MTN_MOMO', 'MOMO', '0200000000', 'PENDING', txRecord.id
                );
                return rows?.[0] || null;
            },
        });

        const fake = acceptingDispatcher();
        await makeSvc(fake).recoverStalePendingRuns();

        // Resumed dispatch used the same canonical network — not 'MOMO', not
        // the MTN default, not a re-read of a different value.
        expect(fake.calls.length).toBe(1);
        expect(fake.calls[0].network).toBe('TELECEL');

        const refreshed = await prisma.smartRouteRun.findUnique({ where: { id: run.id } });
        expect(refreshed.status).toBe('SUCCESS');
    });
});
