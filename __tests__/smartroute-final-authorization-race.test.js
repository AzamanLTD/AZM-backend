// __tests__/smartroute-final-authorization-race.test.js
// =============================================================================
// Smart Route FINAL AUTHORIZATION RACE — the r19 claim freezes the run's
// ECONOMIC identity (amount, action, destination, cadence, occurrence); it
// must NEVER freeze AUTHORIZATION. These proofs pin the invariant:
//
//   "A SmartRouteRun's economic identity is immutable after claim, but its
//    authorization is NOT frozen by the claim."
//
// Proofs against REAL PostgreSQL:
//   1.  ban-after-claim (INTERNAL_TRANSFER): execution is rejected, no debit,
//       no recipient credit, no ledger mutation, no successful terminal run,
//       and the occurrence is consumed exactly once (SKIPPED).
//   2.  ban-after-claim (SAVINGS_DEPOSIT): no debit, no escrow increment, no
//       goal update, no SavingsDeposit row, no ledger posting, run SKIPPED.
//   3.  ban-after-claim (VAULT_DEPOSIT, REAL vaultService): no debit, no
//       vault increment, no VaultDeposit row, run SKIPPED; a re-drive after
//       the ban is lifted executes the NEXT occurrence normally.
//   4.  stale pre-read is never the authority: the _executeClaim() user read
//       is forced to return stale ACTIVE data while the live row is banned —
//       the in-transaction re-proof (the economic boundary) still fails
//       closed for transfer, savings, vault AND momo (no reservation).
//   5.  ban race AT the economic boundary: a concurrent ban and a transfer
//       execution race — exactly one outcome wins by DB ordering, and money
//       NEVER moves on stale authorization.
//   6.  route pause/cancel after claim: the claimed occurrence fails closed
//       at the boundary (the recovery sweep's established semantics, now
//       encoded uniformly), no money moves; future claims on a non-ACTIVE
//       route are skipped; a stale-PENDING recovery of a paused route
//       finalizes FAILED_OTHER without executing.
//   7.  WITHDRAW_MOMO ban after claim: no debit, no canonical reservation,
//       no mirror, no provider I/O, run SKIPPED.
//   8.  WITHDRAW_MOMO ban AFTER the authoritative reservation but BEFORE the
//       dispatch claim: the reservation is reversed HONESTLY through the
//       canonical state machine (balance restored, canonical FAILED, mirror
//       FAILED, run SKIPPED) and the provider is never called — nothing is
//       pretended away.
//   9.  WITHDRAW_MOMO ban DURING provider I/O (after the dispatch claim
//       committed): the dispatch is authoritative — the run honestly
//       reaches its dispatch outcome and the canonical reservation is NOT
//       reversed (the state machine stays honest and recoverable).
//  10.  recovery re-proves authorization: a stale-PENDING run re-driven while
//       the user is banned finalizes SKIPPED with no money movement.
//  11.  concurrent execution: two concurrent executors against one claimed
//       run produce exactly ONE economic outcome (recipient credited once,
//       run SUCCESS once).
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================
const { seedUser, seedFriendship } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[sr-auth-race] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Smart Route final authorization race', () => {
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
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "SavingsGoal", "SavingsDeposit", "Vault", "VaultDeposit", "GlobalSettings", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "Withdrawal", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt", "AzmRewardLog", "AzmSpendLog" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

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

    function makeRealVaultSvc() {
        const { VaultService } = require('../services/vaultService');
        const { AzmRewardService } = require('../services/azmRewardService');
        const rewardSvc = new AzmRewardService(prisma, { to: () => ({ emit: () => {} }) });
        return new VaultService(prisma, { to: () => ({ emit: () => {} }) }, notifStub, rewardSvc);
    }

    async function seedFiatEnv() {
        const observedAt = new Date();
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 15, liveUsdToGhs: 15, lastExternalSync: observedAt, lastRateSync: observedAt, liveRateSource: 'KOTANI_PAY' },
            create: { id: 1, liveRetailRate: 15, liveUsdToGhs: 15, lastExternalSync: observedAt, lastRateSync: observedAt, liveRateSource: 'KOTANI_PAY' }
        });
        await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
        await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
    }

    const PAST = () => new Date(Date.now() - 60 * 60 * 1000);

    async function seedRoute(userId, overrides = {}) {
        return prisma.smartRoute.create({
            data: {
                userId,
                name: 'Auth race route',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: PAST(),
                status: 'ACTIVE',
                ...overrides,
            },
        });
    }

    async function banUser(userId, banStatus = 'BANNED_INDEF') {
        await prisma.user.update({ where: { id: userId }, data: { banStatus } });
    }

    /**
     * Force the service's NON-transactional user reads to return stale
     * ACTIVE authorization data while the live row is banned. The
     * in-transaction re-proofs use the transactional client (tx.user),
     * which is NOT patched — so a test passing under this shim proves the
     * economic boundary itself is the authority, not the pre-read.
     */
    function stubStalePreRead(svc) {
        const orig = svc.prisma.user.findUnique.bind(svc.prisma);
        svc.prisma.user.findUnique = async (args) => {
            const row = await orig(args);
            if (row && row.banStatus !== undefined) return { ...row, banStatus: 'ACTIVE' };
            return row;
        };
        // The prisma client is MODULE-LEVEL and shared across tests — the
        // patch MUST be restored before any final-state assertion reads it.
        return () => { svc.prisma.user.findUnique = orig; };
    }

    test('1: transfer — ban after claim rejects execution with zero money movement and consumes the occurrence once', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        const route = await seedRoute(user.id, { action: 'INTERNAL_TRANSFER', destFriendUserId: friend.id });

        const claim = await svc._claimExecution(route.id, false);
        expect(claim.skipped).toBeUndefined();

        // Authorization is lost AFTER the claim.
        await banUser(user.id);

        // Baseline captured AFTER all seeding so the zero-movement assertions
        // below prove THIS run posted nothing — independent of any ambient
        // journal activity left by fire-and-forget writers of earlier suites
        // (the battery is serial, but pending async work can commit after a
        // suite's own truncate).
        const journalBase = await prisma.journalEntry.count({});

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SKIPPED');
        expect(run.failureReason).toMatch(/no longer active|banned/i);

        // No debit, no recipient credit, no run history, no ledger posting.
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(0, 5);
        expect(await prisma.transactionHistory.count({ where: { type: 'SMART_ROUTE_RUN' } })).toBe(0);
        expect(await prisma.journalEntry.count({})).toBe(journalBase);

        // The occurrence is consumed exactly once: a re-claim of the same
        // route does not mint a second run for it.
        const reclaim = await svc._claimExecution(route.id, false);
        expect(reclaim.skipped).toBe(true);
    });

    test('2: savings — ban after claim rolls back debit, escrow, goal, deposit row, ledger and finalization', async () => {
        await seedFiatEnv();
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'Race goal', targetAmountGhs: 500, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        const route = await seedRoute(user.id, { action: 'SAVINGS_DEPOSIT', destSavingsGoalId: goal.id });

        const claim = await svc._claimExecution(route.id, false);
        await banUser(user.id);

        // Baseline after seeding — see test 1 for the ambient-noise rationale.
        const journalBase = await prisma.journalEntry.count({});

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SKIPPED');
        expect(run.failureReason).toMatch(/no longer active|banned/i);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(Number(freshUser.escrowLockedBalance)).toBeCloseTo(0, 5);
        expect(Number(freshGoal.currentAmountGhs)).toBeCloseTo(0, 5);
        expect(freshGoal.totalDeposits).toBe(0);
        expect(await prisma.savingsDeposit.count({ where: { goalId: goal.id } })).toBe(0);
        expect(await prisma.journalEntry.count({})).toBe(journalBase);
    });

    test('3: vault — ban after claim cannot produce a committed vault deposit; the next occurrence retries once authorized', async () => {
        const vaultSvc = makeRealVaultSvc();
        const svc = makeSvc({ vaultService: vaultSvc });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const vault = await prisma.vault.create({
            data: { userId: user.id, name: 'Race vault', targetAmountUsdc: 100, rulesAcceptedAt: new Date(), maturityDate: new Date(Date.now() + 86400000) },
        });
        const route = await seedRoute(user.id, { action: 'VAULT_DEPOSIT', destVaultId: vault.id });

        const claim = await svc._claimExecution(route.id, false);
        await banUser(user.id);

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SKIPPED');
        expect(run.failureReason).toMatch(/no longer active|banned/i);

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(Number(freshVault.currentAmountUsdc)).toBeCloseTo(0, 5);
        expect(await prisma.vaultDeposit.count({ where: { vaultId: vault.id } })).toBe(0);

        // Retry semantics: authorization restored, next occurrence due —
        // the deposit executes normally (guarded claims + idempotency
        // intact).
        await prisma.user.update({ where: { id: user.id }, data: { banStatus: 'ACTIVE' } });
        await prisma.smartRoute.update({ where: { id: route.id }, data: { nextRunAt: PAST() } });
        const retried = await svc.runOnce(route.id, { manual: false });
        expect(retried.status).toBe('SUCCESS');
        const after = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(after.availableBalance)).toBeCloseTo(490, 5);
        expect(await prisma.vaultDeposit.count({ where: { vaultId: vault.id } })).toBe(1);
    });

    test('4: a stale _executeClaim pre-read is never the authority — the in-transaction re-proof fails closed (transfer, savings, vault, momo)', async () => {
        await seedFiatEnv();
        const calls = [];
        const dispatcher = {
            async initiateTransfer(payload) {
                calls.push(payload);
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', _provider: 'moolre', data: { reference: `moolre_${payload.referenceId}` } };
            },
        };

        // ── transfer ──────────────────────────────────────────────────────
        {
            const svc = makeSvc();
            const user = await seedUser(prisma, { availableBalance: 500 });
            const friend = await seedUser(prisma, { availableBalance: 0 });
            await seedFriendship(prisma, user.id, friend.id);
            const route = await seedRoute(user.id, { action: 'INTERNAL_TRANSFER', destFriendUserId: friend.id });
            const claim = await svc._claimExecution(route.id, false);
            await banUser(user.id);
            const unpatch = stubStalePreRead(svc); // the pre-read LIES: says ACTIVE
            try {
                const run = await svc._executeClaim(claim);
                expect(run.status).toBe('SKIPPED');
            } finally { unpatch(); }
            const friend2 = await prisma.user.findUnique({ where: { id: friend.id } });
            expect(Number(friend2.availableBalance)).toBeCloseTo(0, 5);
        }

        // ── savings ──────────────────────────────────────────────────────
        {
            const svc = makeSvc();
            const user = await seedUser(prisma, { availableBalance: 500 });
            const goal = await prisma.savingsGoal.create({ data: { userId: user.id, name: 'G', targetAmountGhs: 500, frequencyAmount: 10 } });
            const route = await seedRoute(user.id, { action: 'SAVINGS_DEPOSIT', destSavingsGoalId: goal.id });
            const claim = await svc._claimExecution(route.id, false);
            await banUser(user.id);
            const unpatch = stubStalePreRead(svc);
            try {
                const run = await svc._executeClaim(claim);
                expect(run.status).toBe('SKIPPED');
            } finally { unpatch(); }
            const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
            expect(Number(freshUser.escrowLockedBalance)).toBeCloseTo(0, 5);
        }

        // ── vault (REAL vaultService) ────────────────────────────────────
        {
            const vaultSvc = makeRealVaultSvc();
            const svc = makeSvc({ vaultService: vaultSvc });
            const user = await seedUser(prisma, { availableBalance: 500 });
            const vault = await prisma.vault.create({ data: { userId: user.id, name: 'V', targetAmountUsdc: 100, rulesAcceptedAt: new Date(), maturityDate: new Date(Date.now() + 86400000) } });
            const route = await seedRoute(user.id, { action: 'VAULT_DEPOSIT', destVaultId: vault.id });
            const claim = await svc._claimExecution(route.id, false);
            await banUser(user.id);
            const unpatch = stubStalePreRead(svc);
            try {
                const run = await svc._executeClaim(claim);
                expect(run.status).toBe('SKIPPED');
            } finally { unpatch(); }
            const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
            expect(Number(freshVault.currentAmountUsdc)).toBeCloseTo(0, 5);
            // A blocked attempt leaves vaultService's honest FAILED_OTHER
            // audit row; a COMMITTED deposit would be the violation.
            expect(await prisma.vaultDeposit.count({ where: { vaultId: vault.id, status: 'COMPLETED' } })).toBe(0);
        }

        // ── momo: no reservation may commit on stale authorization ────────
        {
            const svc = makeSvc({ dispatcher });
            const user = await seedUser(prisma, { availableBalance: 500 });
            const route = await seedRoute(user.id, { action: 'WITHDRAW_MOMO', destMomoNumber: '0240000000', destMomoProvider: 'MTN' });
            const claim = await svc._claimExecution(route.id, false);
            await banUser(user.id);
            const unpatch = stubStalePreRead(svc);
            try {
                const run = await svc._executeClaim(claim);
                expect(run.status).toBe('SKIPPED');
            } finally { unpatch(); }
            expect(await prisma.transactionHistory.count({ where: { type: 'WITHDRAWAL_FIAT' } })).toBe(0);
            expect(await prisma.withdrawal.count({})).toBe(0);
            expect(calls.length).toBe(0);
            const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        }
    });

    test('5: ban racing the transfer transaction — exactly one outcome wins by DB ordering, never stale-authorized money', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        const route = await seedRoute(user.id, { action: 'INTERNAL_TRANSFER', destFriendUserId: friend.id });
        const claim = await svc._claimExecution(route.id, false);

        // The pre-read lies ACTIVE so the race is decided at the guarded
        // debit INSIDE the money transaction, against the live row.
        const unpatch = stubStalePreRead(svc);
        await Promise.all([
            banUser(user.id),
            svc._executeClaim(claim),
        ]);
        unpatch();

        const run = await prisma.smartRouteRun.findUnique({ where: { id: claim.run.id } });
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });

        // Exactly one honest outcome:
        if (run.status === 'SUCCESS') {
            // The debit committed BEFORE the ban landed — legitimate DB
            // ordering, but the money MUST be consistent (moved exactly
            // once) and the ban MUST have landed after the fact.
            expect(Number(freshFriend.availableBalance)).toBeCloseTo(10, 5);
            expect(Number(freshUser.availableBalance)).toBeCloseTo(490, 5);
            expect(freshUser.banStatus).toBe('BANNED_INDEF');
        } else {
            // The ban won — no money may have moved on stale authorization.
            expect(run.status).toBe('SKIPPED');
            expect(Number(freshFriend.availableBalance)).toBeCloseTo(0, 5);
            expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        }
        // Never both: money moved AND a non-SUCCESS terminal state.
        const moneyMoved = Number(freshFriend.availableBalance) > 0;
        expect(moneyMoved).toBe(run.status === 'SUCCESS');
    });

    test('6: route pause/cancel after claim — claimed occurrence fails closed at the boundary; future claims skip; recovery of a paused route never executes', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        const route = await seedRoute(user.id, { action: 'INTERNAL_TRANSFER', destFriendUserId: friend.id });

        // (a) pause AFTER the claim: the claimed occurrence fails closed at
        // the economic boundary (the recovery sweep's established route
        // semantics, now uniform — a pause/cancel must not become stale
        // authorization data).
        const claim = await svc._claimExecution(route.id, false);
        await svc.setStatus(user.id, route.id, 'PAUSED');
        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('FAILED_OTHER');
        expect(run.failureReason).toMatch(/route no longer active/i);
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(0, 5);

        // (b) future claims on a PAUSED route never mint a run.
        await prisma.smartRoute.update({ where: { id: route.id }, data: { nextRunAt: PAST() } });
        const pausedClaim = await svc._claimExecution(route.id, false);
        expect(pausedClaim.skipped).toBe(true);

        // (c) recovery of a stale-PENDING run on a non-ACTIVE route
        // finalizes FAILED_OTHER without executing (established semantics).
        await prisma.smartRoute.update({ where: { id: route.id }, data: { status: 'CANCELLED' } });
        await prisma.smartRouteRun.update({ where: { id: claim.run.id }, data: { status: 'PENDING', createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
        const outcomes = await svc.recoverStalePendingRuns();
        expect(outcomes.length).toBe(1);
        const afterRecovery = await prisma.smartRouteRun.findUnique({ where: { id: claim.run.id } });
        expect(afterRecovery.status).toBe('FAILED_OTHER');
        expect(afterRecovery.failureReason).toMatch(/route no longer active/i);
        const freshFriend2 = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend2.availableBalance)).toBeCloseTo(0, 5);
    });

    test('7: momo — ban after claim blocks before the canonical reservation: no debit, no canonical row, no mirror, no provider I/O', async () => {
        await seedFiatEnv();
        const calls = [];
        const dispatcher = {
            async initiateTransfer(payload) {
                calls.push(payload);
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', _provider: 'moolre', data: { reference: `moolre_${payload.referenceId}` } };
            },
        };
        const svc = makeSvc({ dispatcher });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedRoute(user.id, { action: 'WITHDRAW_MOMO', destMomoNumber: '0240000000', destMomoProvider: 'MTN' });

        const claim = await svc._claimExecution(route.id, false);
        await banUser(user.id);

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SKIPPED');
        expect(run.failureReason).toMatch(/no longer active|banned/i);

        expect(await prisma.transactionHistory.count({ where: { type: 'WITHDRAWAL_FIAT' } })).toBe(0);
        expect(await prisma.withdrawal.count({})).toBe(0);
        expect(calls.length).toBe(0);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
    });

    test('8: momo — ban AFTER the authoritative reservation but BEFORE the dispatch claim: honest reversal, never a fake provider call', async () => {
        await seedFiatEnv();
        const calls = [];
        const dispatcher = {
            async initiateTransfer(payload) {
                calls.push(payload);
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', _provider: 'moolre', data: { reference: `moolre_${payload.referenceId}` } };
            },
        };
        const svc = makeSvc({ dispatcher });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const route = await seedRoute(user.id, { action: 'WITHDRAW_MOMO', destMomoNumber: '0240000000', destMomoProvider: 'MTN' });
        const claim = await svc._claimExecution(route.id, false);

        // The ban lands after the reservation commits but before the
        // dispatch claim transaction: authorization is lost at the LAST
        // SAFE BOUNDARY before provider I/O.
        const originalDispatch = svc._dispatchMomoPayout.bind(svc);
        svc._dispatchMomoPayout = async (run, rt, reservation, opts) => {
            const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reservation.reference } });
            expect(canonical.status).toBe('PENDING'); // reservation IS authoritative at this point
            await banUser(rt.userId);
            return originalDispatch(run, rt, reservation, opts);
        };

        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SKIPPED');
        // The run's failureReason is the CONVERGED reversal reason, which
        // carries the authorization detail (what was lost and why).
        expect(run.failureReason).toMatch(/authorization_lost_before_dispatch/);
        expect(run.failureReason).toMatch(/no longer active/i);

        // The provider was NEVER called — nothing is pretended away.
        expect(calls.length).toBe(0);

        // The canonical reservation was reversed HONESTLY through the
        // state machine: FAILED, and the user's balance is fully restored.
        const reference = `SRWD_${claim.run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        expect(mirror.status).toBe('FAILED');
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(freshUser.banStatus).toBe('BANNED_INDEF');
    });

    test('9: momo — ban DURING provider I/O (after the dispatch claim committed): dispatch stays authoritative, no dishonest reversal', async () => {
        await seedFiatEnv();
        const calls = [];
        const dispatcher = {
            async initiateTransfer(payload) {
                calls.push(payload);
                // The ban lands mid-flight: AFTER the DB-authoritative
                // dispatch claim, DURING the irreversible provider call.
                await banUser(banMidFlightUserId);
                return { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', _provider: 'moolre', data: { reference: `moolre_${payload.referenceId}` } };
            },
        };
        const svc = makeSvc({ dispatcher });
        const user = await seedUser(prisma, { availableBalance: 500 });
        let banMidFlightUserId = user.id;
        const route = await seedRoute(user.id, { action: 'WITHDRAW_MOMO', destMomoNumber: '0240000000', destMomoProvider: 'MTN' });
        const claim = await svc._claimExecution(route.id, false);

        const run = await svc._executeClaim(claim);

        // The dispatch was accepted BEFORE the ban hit — the run honestly
        // reached the successful dispatch state and the reservation is NOT
        // reversed (settlement owns the canonical).
        expect(run.status).toBe('SUCCESS');
        const reference = `SRWD_${claim.run.id}`;
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('PENDING');
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeLessThan(500); // the reservation holds — not refunded by guess
        expect(freshUser.banStatus).toBe('BANNED_INDEF');
        expect(calls.length).toBe(1);
    });

    test('10: recovery re-proves live authorization — a stale-PENDING re-drive of a banned user finalizes SKIPPED with no money movement', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        const route = await seedRoute(user.id, { action: 'INTERNAL_TRANSFER', destFriendUserId: friend.id });

        // Claim, then simulate a crash before execution.
        const claim = await svc._claimExecution(route.id, false);
        await prisma.smartRouteRun.update({
            where: { id: claim.run.id },
            data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
        });

        // The user is banned when the recovery sweep re-drives the run.
        await banUser(user.id);
        const outcomes = await svc.recoverStalePendingRuns();
        expect(outcomes.length).toBe(1);

        const run = await prisma.smartRouteRun.findUnique({ where: { id: claim.run.id } });
        expect(run.status).toBe('SKIPPED');
        expect(run.failureReason).toMatch(/no longer active|banned/i);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(0, 5);
    });

    test('11: concurrent execution against one claimed run produces exactly one economic outcome', async () => {
        const svc = makeSvc();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedFriendship(prisma, user.id, friend.id);
        const route = await seedRoute(user.id, { action: 'INTERNAL_TRANSFER', destFriendUserId: friend.id });
        const claim = await svc._claimExecution(route.id, false);

        // Two concurrent executors (e.g. worker + recovery) race the SAME
        // claimed run. The guarded finalization admits exactly one winner;
        // the loser's whole money transaction rolls back.
        await Promise.all([
            svc._executeClaim(claim),
            svc._executeClaim(claim),
        ]);

        const run = await prisma.smartRouteRun.findUnique({ where: { id: claim.run.id } });
        expect(run.status).toBe('SUCCESS');
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        const freshFriend = await prisma.user.findUnique({ where: { id: friend.id } });
        expect(Number(freshFriend.availableBalance)).toBeCloseTo(10, 5);  // credited EXACTLY once
        expect(Number(freshUser.availableBalance)).toBeCloseTo(490, 5);    // debited EXACTLY once
        expect(await prisma.transactionHistory.count({ where: { type: 'SMART_ROUTE_RUN' } })).toBe(1);
        const freshRoute = await prisma.smartRoute.findUnique({ where: { id: route.id } });
        expect(freshRoute.totalRuns).toBe(1); // route economics incremented once
    });
});
