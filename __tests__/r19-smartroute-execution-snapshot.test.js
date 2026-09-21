// __tests__/r19-smartroute-execution-snapshot.test.js
// =============================================================================
// r19 P0 proofs — a claimed SmartRouteRun is an IMMUTABLE execution snapshot.
//
// Proves against REAL PostgreSQL:
//   1.  claim → route edit (amount + destination) → execute: the execution
//       uses the CLAIMED amount/destination, not the edited route
//       (INTERNAL_TRANSFER)
//   2.  same immutability for SAVINGS_DEPOSIT (amount + goal), plus the
//       savings-canonical denomination (liveUsdToGhs) and honest run
//       economics recording
//   3.  same immutability for VAULT_DEPOSIT (amount + vault)
//   4.  same immutability for WITHDRAW_MOMO (amount + number + network)
//   5.  claim → edit → crash-simulate → recover: recovery re-drives the run
//       from the ORIGINAL snapshot
//   6.  claim → schedule edit (frequency) → execute: the claimed occurrence
//       advances on the CLAIMED cadence, not the edited one
//   7.  claim → dayOfMonth edit: ON_DAY_OF_MONTH patches are now accepted by
//       update() (the old FREQUENCY_MS gate silently rejected them)
//   8.  manual run (nothing due) carries its own snapshot and never touches
//       the schedule
//   9.  INTERNAL_TRANSFER recipient authorization: no friendship / pending
//       friendship / banned recipient / self transfer all fail CLOSED with
//       no money movement, and the occurrence is consumed exactly once
//   10. friendship revoked between claim and execution: execution fails
//       closed
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================
const { seedUser, seedFriendship } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r19-snapshot] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r19 P0: Smart Route immutable execution snapshot', () => {
    let prisma, notifStub;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        const { SmartRouteService } = require('../services/smartRouteService');
        prisma = new PrismaClient();
        notifStub = { sendNotification: async () => ({}) };
        globalThis.__svc = null;
    });

    function makeSvc({ dispatcher = null, vaultService = null } = {}) {
        const { SmartRouteService } = require('../services/smartRouteService');
        return new SmartRouteService({
            prisma,
            io: null,
            notificationService: notifStub,
            mtnDisbursementService: dispatcher,
            vaultService,
        });
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

    async function seedTransferRoute(userId, overrides = {}) {
        const past = new Date(Date.now() - 60 * 60 * 1000);
        return prisma.smartRoute.create({
            data: {
                userId,
                name: 'Snapshot route',
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

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "SavingsGoal", "SavingsDeposit", "Vault", "VaultDeposit", "GlobalSettings", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "Withdrawal", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

    test('1: transfer — claim → edit amount+destination → execute uses the CLAIMED snapshot', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friendA = await seedUser(prisma, { availableBalance: 0 });
        const friendB = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friendA.id);
        await seedFriendship(prisma, user.id, friendB.id);
        const route = await seedTransferRoute(user.id, { destFriendUserId: friendA.id });

        // 1. Claim the due occurrence.
        const claim = await svc._claimExecution(route.id, false);
        expect(claim.skipped).toBeUndefined();
        // 2. The snapshot is frozen at claim time.
        expect(Number(claim.run.amountUsdc)).toBe(10);
        expect(claim.run.action).toBe('INTERNAL_TRANSFER');
        expect(claim.run.destFriendUserId).toBe(friendA.id);
        expect(claim.run.frequency).toBe('WEEKLY');
        expect(claim.run.claimedOccurrenceAt).toEqual(route.nextRunAt);

        // 3. The user edits BOTH the amount and the destination mid-flight.
        await svc.update(user.id, route.id, { amountUsdc: 99 });
        await svc.update(user.id, route.id, { destination: { friendUserId: friendB.id } });

        // 4. Execute the CLAIMED run — the snapshot must win.
        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        const freshA = await prisma.user.findUnique({ where: { id: friendA.id } });
        const freshB = await prisma.user.findUnique({ where: { id: friendB.id } });
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshA.availableBalance)).toBeCloseTo(10, 5);   // CLAIMED destination + amount
        expect(Number(freshB.availableBalance)).toBeCloseTo(0, 5);    // edited destination NOT used
        expect(Number(freshUser.availableBalance)).toBeCloseTo(490, 5);

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.totalRuns).toBe(1);
        expect(Number(refreshedRoute.totalRoutedUsdc)).toBeCloseTo(10, 5); // CLAIMED amount, not 99
        expect(refreshedRoute.destFriendUserId).toBe(friendB.id);      // the edit persists for FUTURE runs
        expect(Number(refreshedRoute.amountUsdc)).toBe(99);
    });

    test('2: savings — claim → edit amount+goal → execute deposits to the CLAIMED goal at liveUsdToGhs; run records economics', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goalA = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'A', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        const goalB = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'B', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        // Savings-canonical rate: liveUsdToGhs. A DIFFERENT retail rate must
        // NOT influence the savings denomination (r19 P0-5).
        await seedFiatEnv();
        await prisma.globalSettings.update({ where: { id: 1 }, data: { liveRetailRate: 12.5, liveUsdToGhs: 15 } });

        const past = new Date(Date.now() - 60 * 60 * 1000);
        const route = await prisma.smartRoute.create({
            data: {
                userId: user.id,
                name: 'Savings route',
                action: 'SAVINGS_DEPOSIT',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destSavingsGoalId: goalA.id,
            },
        });

        const claim = await svc._claimExecution(route.id, false);
        await svc.update(user.id, route.id, { amountUsdc: 99 });
        await svc.update(user.id, route.id, { destination: { savingsGoalId: goalB.id } });

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        const freshA = await prisma.savingsGoal.findUnique({ where: { id: goalA.id } });
        const freshB = await prisma.savingsGoal.findUnique({ where: { id: goalB.id } });
        expect(Number(freshA.currentAmountGhs)).toBeCloseTo(150, 5); // 10 USDC × liveUsdToGhs 15 (CLAIMED goal+amount)
        expect(Number(freshB.currentAmountGhs)).toBeCloseTo(0, 5);

        // Honest run economics recorded.
        expect(Number(run.amountGhs)).toBeCloseTo(150, 5);
        expect(Number(run.rateUsed)).toBeCloseTo(15, 5);

        const deposits = await prisma.savingsDeposit.findMany({ where: { goalId: goalA.id } });
        expect(deposits.length).toBe(1);
        expect(Number(deposits[0].amountUsdc)).toBeCloseTo(10, 5);
    });

    test('3: vault — claim → edit amount+vault → execute deposits into the CLAIMED vault with the CLAIMED amount', async () => {
        const deposits = [];
        const vaultService = {
            async depositManual(payload) {
                deposits.push(payload);
            },
        };
        const svc = makeSvc({ vaultService });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const vaultA = await prisma.vault.create({ data: { userId: user.id, name: 'A', targetAmountUsdc: 100, rulesAcceptedAt: new Date(), maturityDate: new Date(Date.now() + 86400000) } });
        const vaultB = await prisma.vault.create({ data: { userId: user.id, name: 'B', targetAmountUsdc: 100, rulesAcceptedAt: new Date(), maturityDate: new Date(Date.now() + 86400000) } });

        const past = new Date(Date.now() - 60 * 60 * 1000);
        const route = await prisma.smartRoute.create({
            data: {
                userId: user.id,
                name: 'Vault route',
                action: 'VAULT_DEPOSIT',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destVaultId: vaultA.id,
            },
        });

        const claim = await svc._claimExecution(route.id, false);
        await svc.update(user.id, route.id, { amountUsdc: 99 });
        await svc.update(user.id, route.id, { destination: { vaultId: vaultB.id } });

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');
        expect(deposits.length).toBe(1);
        expect(deposits[0].vaultId).toBe(vaultA.id);                 // CLAIMED vault
        expect(Number(deposits[0].amountUsdc)).toBeCloseTo(10, 5);  // CLAIMED amount
    });

    test('4: momo — claim → edit amount+number+network → reservation uses the CLAIMED destination economics', async () => {
        await seedFiatEnv();
        const calls = [];
        const dispatcher = {
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
        const svc = makeSvc({ dispatcher });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const past = new Date(Date.now() - 60 * 60 * 1000);
        const route = await prisma.smartRoute.create({
            data: {
                userId: user.id,
                name: 'MoMo route',
                action: 'WITHDRAW_MOMO',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destMomoNumber: '0240000000',
                destMomoProvider: 'MTN',
            },
        });

        const claim = await svc._claimExecution(route.id, false);
        await svc.update(user.id, route.id, { amountUsdc: 99 });
        await svc.update(user.id, route.id, {
            destination: { momoNumber: '0200000000', momoProvider: 'TELECEL' },
        });

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        // The canonical reservation + provider dispatch used the CLAIMED
        // destination (number + network) and amount.
        const reference = `SRWD_${run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(Number(canonical.amountUsdc)).toBeCloseTo(10, 5);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        expect(mirror.destination).toBe('0240000000');
        expect(mirror.network).toBe('MTN');
        expect(calls.length).toBe(1);
        expect(calls[0].recipientPhone).toBe('0240000000');
        expect(calls[0].network).toBe('MTN');
    });

    test('5: claim → edit → crash-simulate → recovery re-drives from the ORIGINAL snapshot', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friendA = await seedUser(prisma, { availableBalance: 0 });
        const friendB = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friendA.id);
        await seedFriendship(prisma, user.id, friendB.id);
        const route = await seedTransferRoute(user.id, { destFriendUserId: friendA.id });

        // Claim, then edit amount + destination mid-flight.
        const claim = await svc._claimExecution(route.id, false);
        await svc.update(user.id, route.id, { amountUsdc: 99 });
        await svc.update(user.id, route.id, { destination: { friendUserId: friendB.id } });

        // Simulate the process crashing before execution: the claimed run
        // becomes stale PENDING (its financial transaction never committed).
        await prisma.smartRouteRun.update({
            where: { id: claim.run.id },
            data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
        });

        const outcomes = await svc.recoverStalePendingRuns();
        expect(outcomes.length).toBe(1);

        const run = await prisma.smartRouteRun.findUnique({ where: { id: claim.run.id } });
        expect(run.status).toBe('SUCCESS');

        // Recovery moved the CLAIMED amount to the CLAIMED recipient.
        const freshA = await prisma.user.findUnique({ where: { id: friendA.id } });
        const freshB = await prisma.user.findUnique({ where: { id: friendB.id } });
        expect(Number(freshA.availableBalance)).toBeCloseTo(10, 5);
        expect(Number(freshB.availableBalance)).toBeCloseTo(0, 5);
    });

    test('6: claim → frequency edit → execute advances on the CLAIMED cadence from the CLAIMED occurrence', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        const route = await seedTransferRoute(user.id, { destFriendUserId: friend.id });
        const claimedOccurrence = route.nextRunAt;

        const claim = await svc._claimExecution(route.id, false);
        // Edit the schedule WEEKLY → MONTHLY between claim and execution.
        await svc.update(user.id, route.id, { frequency: 'MONTHLY' });

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(refreshedRoute.frequency).toBe('MONTHLY'); // the edit persists for FUTURE occurrences
        // The CLAIMED occurrence advanced on the CLAIMED cadence (WEEKLY =
        // +7d from the claimed base), NOT the edited MONTHLY cadence.
        const expected = new Date(claimedOccurrence.getTime() + 7 * 86400000);
        expect(refreshedRoute.nextRunAt.getTime()).toBe(expected.getTime());
    });

    test('7: update() accepts ON_DAY_OF_MONTH patches (the old gate silently rejected them)', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedTransferRoute(user.id, { destFriendUserId: user.id });

        await expect(svc.update(user.id, route.id, { frequency: 'ON_DAY_OF_MONTH', dayOfMonth: 15 }))
            .resolves.toMatchObject({ frequency: 'ON_DAY_OF_MONTH', dayOfMonth: 15 });
        await expect(svc.update(user.id, route.id, { frequency: 'BOGUS' }))
            .rejects.toThrow(/Invalid frequency/);
        await expect(svc.update(user.id, route.id, { frequency: 'ON_DAY_OF_MONTH', dayOfMonth: 31 }))
            .rejects.toThrow(/dayOfMonth/);
    });

    test('8: manual run (nothing due) carries a snapshot, does not touch the schedule, executes after an edit', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        // nextRunAt in the FUTURE — nothing is due.
        const route = await prisma.smartRoute.create({
            data: {
                userId: user.id,
                name: 'Manual route',
                action: 'INTERNAL_TRANSFER',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 86400000),
                nextRunAt: new Date(Date.now() + 7 * 86400000),
                status: 'ACTIVE',
                destFriendUserId: friend.id,
            },
        });

        const claim = await svc._claimExecution(route.id, true);
        expect(claim.skipped).toBeUndefined();
        expect(claim.run.action).toBe('INTERNAL_TRANSFER');
        expect(claim.occurrenceBased).toBe(false);
        expect(claim.run.claimedOccurrenceAt).toBe(null);

        await svc.update(user.id, route.id, { amountUsdc: 42 });
        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');
        expect(Number(run.amountUsdc)).toBeCloseTo(10, 5);

        const refreshedRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(10, 5);
        // Manual run: schedule untouched, occurrence not consumed.
        expect(refreshedRoute.nextRunAt.getTime()).toBe(route.nextRunAt.getTime());
    });

    test('9: transfer recipient authorization fails closed (no friendship / pending / banned / self)', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });

        // A stranger — never a friend.
        const stranger = await seedUser(prisma, { availableBalance: 0 });
        const strangerRoute = await seedTransferRoute(user.id, { destFriendUserId: stranger.id });
        const strangerClaim = await svc._claimExecution(strangerRoute.id, false);
        const strangerRun = await svc._executeClaim(strangerClaim);
        expect(strangerRun.status).toBe('FAILED_OTHER');
        expect(strangerRun.failureReason).toContain('friendship');
        const strangerFresh = await prisma.user.findUnique({ where: { id: stranger.id } });
        expect(Number(strangerFresh.availableBalance)).toBeCloseTo(0, 5);
        // The failed occurrence is consumed exactly once.
        const strangerRouteFresh = await prisma.smartRoute.findUnique({ where: { id: strangerRoute.id } });
        expect(strangerRouteFresh.totalRuns).toBe(0);
        expect(strangerRouteFresh.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        // Re-driving the same run cannot move money.
        await prisma.smartRouteRun.update({ where: { id: strangerRun.id }, data: { createdAt: new Date(Date.now() - 86400000) } });
        await svc.recoverStalePendingRuns();
        const strangerAfter = await prisma.user.findUnique({ where: { id: stranger.id } });
        expect(Number(strangerAfter.availableBalance)).toBeCloseTo(0, 5);

        // PENDING friendship is NOT an accepted friendship.
        const pendingFriend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, pendingFriend.id, 'PENDING');
        const pendingRoute = await seedTransferRoute(user.id, { destFriendUserId: pendingFriend.id });
        const pendingRun = await svc.runOnce(pendingRoute.id);
        expect(pendingRun.status).toBe('FAILED_OTHER');
        expect(Number((await prisma.user.findUnique({ where: { id: pendingFriend.id } })).availableBalance)).toBeCloseTo(0, 5);

        // Banned recipient fails closed.
        const banned = await seedUser(prisma, { availableBalance: 0, banStatus: 'BANNED_INDEF' });
        await seedFriendship(prisma, user.id, banned.id);
        const bannedRoute = await seedTransferRoute(user.id, { destFriendUserId: banned.id });
        const bannedRun = await svc.runOnce(bannedRoute.id);
        expect(bannedRun.status).toBe('FAILED_OTHER');
        expect(bannedRun.failureReason).toContain('not active');

        // Self transfer fails closed.
        const selfRoute = await seedTransferRoute(user.id, { destFriendUserId: user.id });
        const selfRun = await svc.runOnce(selfRoute.id);
        expect(selfRun.status).toBe('FAILED_OTHER');
        expect(selfRun.failureReason).toContain('sender');

        // Nonexistent recipient fails closed.
        const ghostRoute = await seedTransferRoute(user.id, { destFriendUserId: 999999 });
        const ghostRun = await svc.runOnce(ghostRoute.id);
        expect(ghostRun.status).toBe('FAILED_OTHER');
        expect(ghostRun.failureReason).toContain('not found');

        // The sender's balance never moved on any failed path.
        const userFresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(userFresh.availableBalance)).toBeCloseTo(500, 5);
    });

    test('10: friendship revoked between claim and execution → execution fails closed', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        const friendship = await seedFriendship(prisma, user.id, friend.id);
        const route = await seedTransferRoute(user.id, { destFriendUserId: friend.id });

        const claim = await svc._claimExecution(route.id, false);

        // The friendship is revoked (or declined) after the claim.
        await prisma.friendship.update({ where: { id: friendship.id }, data: { status: 'REJECTED' } });

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('FAILED_OTHER');
        expect(run.failureReason).toContain('friendship');
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(0, 5);
    });
});
