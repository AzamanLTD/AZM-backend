// __tests__/r271e-smartroute-savings-rate-authority.test.js
// =============================================================================
// §271 residual audit — Smart Route savings conversion rate authority.
//
// Proves against REAL PostgreSQL (the fix is a rate-AUTHORITY change on a
// money path, so the proofs are economic, not just structural):
//
//   1. The savings executor deposits at the ONE canonical freshness-gated
//      RETAIL rate (getFreshServerRateGhsPerUsdc — the same authority as
//      the manual savings deposit/withdrawal quotes), even when the legacy
//      liveUsdToGhs field diverges (FALLBACK_FX oracle mode: raw USD/GHS vs
//      USDC-adjusted retail).
//   2. The conversion carries trustworthy provenance: the ledger deposit
//      records rateUsed + rateSource + rateAsOf (the TRUE external
//      observation the freshness gate enforced against).
//   3. A stale external observation FAILS CLOSED: no debit, no goal credit,
//      no SavingsDeposit row, run terminal FAILED with a rate-classified
//      reason — a frozen oracle can never mint goal GHS at an ancient rate.
//   4. A MISSING external observation fails closed the same way
//      (RATE_UNAVAILABLE, not a fallback rate).
//   5. Round-trip symmetry with the withdrawal authority: GHS minted by the
//      executor at the gated retail rate converts back to the SAME USDC at
//      a withdrawal quote struck at the same observation — the
//      denomination-seam value asymmetry (the r19 reopened seam) is closed.
//   6. Exactly-once economics survive the change: a successful run debits
//      the user and posts the escrow ledger entry EXACTLY once (the guarded
//      run finalization remains the single-winner claim).
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r271e] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('271E Smart Route savings rate authority', () => {
    let prisma, notifStub;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        notifStub = { sendNotification: async () => ({}) };
    });

    function makeSvc() {
        const { SmartRouteService } = require('../services/smartRouteService');
        return new SmartRouteService({
            prisma,
            io: null,
            notificationService: notifStub,
            mtnDisbursementService: null,
            vaultService: null,
        });
    }

    async function seedObservation({ retailRate = 12.5, legacyUsdToGhs = 15, observedAt = new Date() } = {}) {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: retailRate,
                liveUsdToGhs: legacyUsdToGhs,
                lastExternalSync: observedAt,
                lastRateSync: observedAt,
                liveRateSource: 'KOTANI_PAY',
            },
            create: {
                id: 1,
                liveRetailRate: retailRate,
                liveUsdToGhs: legacyUsdToGhs,
                lastExternalSync: observedAt,
                lastRateSync: observedAt,
                liveRateSource: 'KOTANI_PAY',
            },
        });
    }

    async function seedSavingsRoute(userId, goalId, overrides = {}) {
        const past = new Date(Date.now() - 60 * 60 * 1000);
        return prisma.smartRoute.create({
            data: {
                userId,
                name: 'Savings route',
                action: 'SAVINGS_DEPOSIT',
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: past,
                status: 'ACTIVE',
                destSavingsGoalId: goalId,
                ...overrides,
            },
        });
    }

    const TRUNCATE = async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "SavingsGoal", "SavingsDeposit", "GlobalSettings", "Withdrawal", "TransactionQuote" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE'
        );
    };

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    afterEach(TRUNCATE);

    test('1: fresh observation → deposit at the canonical RETAIL rate — the divergent legacy liveUsdToGhs must NOT win', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'G', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        // FALLBACK_FX signature: retail (USDC-adjusted) 12.5 vs raw USD/GHS 15.
        await seedObservation({ retailRate: 12.5, legacyUsdToGhs: 15 });

        const route = await seedSavingsRoute(user.id, goal.id);
        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('SUCCESS');
        const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(freshGoal.currentAmountGhs)).toBeCloseTo(125, 5); // 10 × 12.5, never 10 × 15
        expect(Number(run.amountGhs)).toBeCloseTo(125, 5);
        expect(Number(run.rateUsed)).toBeCloseTo(12.5, 5);
    });

    test('2: the escrow ledger entry records TRUE provenance — rateUsed, rateSource and rateAsOf', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'G', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        const observedAt = new Date(Date.now() - 30 * 1000);
        await seedObservation({ retailRate: 11.75, legacyUsdToGhs: 14, observedAt });

        const route = await seedSavingsRoute(user.id, goal.id);
        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        const ledgerTx = await prisma.ledgerTransaction.findFirst({
            where: { metadata: { path: ['smartRouteRunId'], equals: run.id } },
        });
        expect(ledgerTx).not.toBeNull();
        const md = ledgerTx.metadata;
        expect(Number(md.rateUsed)).toBeCloseTo(11.75, 5);
        expect(md.rateSource).toBe('KOTANI_PAY');
        // rateAsOf is the TRUE external observation — NOT the execution time.
        expect(new Date(md.rateAsOf).toISOString()).toBe(observedAt.toISOString());
    });

    test('3: STALE observation → fail closed: no debit, no goal credit, no SavingsDeposit row, run FAILED with the rate reason', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'G', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        // Older than the gate's maximum age (default 1800 s).
        const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await seedObservation({ retailRate: 12.5, legacyUsdToGhs: 15, observedAt: ancient });

        const route = await seedSavingsRoute(user.id, goal.id);
        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('FAILED_OTHER');
        expect(run.failureReason).toMatch(/Smart Route savings deposit blocked — stale\/unavailable rate/);
        expect(run.failureReason).toMatch(/RATE_STALE/);

        // NOTHING moved.
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
        expect(Number(freshUser.escrowLockedBalance)).toBeCloseTo(0, 8);
        const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(freshGoal.currentAmountGhs)).toBeCloseTo(0, 5);
        const deposits = await prisma.savingsDeposit.findMany({ where: { goalId: goal.id } });
        expect(deposits.length).toBe(0);
        const ledgerTx = await prisma.ledgerTransaction.findMany({
            where: { metadata: { path: ['smartRouteRunId'], equals: run.id } },
        });
        expect(ledgerTx.length).toBe(0);
    });

    test('4: MISSING observation → fail closed with RATE_UNAVAILABLE — no fallback rate is ever fabricated', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'G', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        // Rates present but NO trustworthy external timestamp: the pre-271B
        // world. The executor must NOT fall back to the cached number.
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 12.5, liveUsdToGhs: 15, lastExternalSync: null },
            create: { id: 1, liveRetailRate: 12.5, liveUsdToGhs: 15 },
        });

        const route = await seedSavingsRoute(user.id, goal.id);
        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('FAILED_OTHER');
        expect(run.failureReason).toMatch(/RATE_UNAVAILABLE/);
        const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(freshGoal.currentAmountGhs)).toBeCloseTo(0, 5);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(500, 5);
    });

    test('5: round-trip symmetry — GHS minted at the gated retail rate converts back to the SAME USDC at a withdrawal quote struck at the same observation', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'G', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        await seedObservation({ retailRate: 12.5, legacyUsdToGhs: 15 });

        const route = await seedSavingsRoute(user.id, goal.id);
        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        const freshGoal = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        const mintedGhs = Number(freshGoal.currentAmountGhs); // 125

        // A withdrawal quote at the SAME observation prices the SAME USDC.
        // (Under the pre-fix executor this round-trip returned 125/15 = 8.33
        // USDC or, at a later retail quote, 125/12.5 = 10 — the seam.)
        const {
            createServerTransactionQuote,
            consumeTransactionQuote,
        } = require('../src/services/transactionQuoteService');
        const quote = await createServerTransactionQuote({
            prisma,
            userId: user.id,
            purpose: 'savings_withdrawal',
            amountGhs: mintedGhs,
            feeGhs: 0,
            ttlSeconds: 120,
        });
        expect(Number(quote.usdcAmount)).toBeCloseTo(10, 5); // 125 GHS ÷ 12.5 — the 10 USDC that was locked
        const consumed = await consumeTransactionQuote({
            prisma,
            quoteId: quote.id,
            userId: user.id,
            purpose: 'savings_withdrawal',
        });
        expect(consumed.id).toBe(quote.id);
    });

    test('6: exactly-once economics — a successful run debits and posts the escrow entry EXACTLY once', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const goal = await prisma.savingsGoal.create({
            data: { userId: user.id, name: 'G', targetAmountGhs: 1000, currentAmountGhs: 0, frequencyAmount: 10 },
        });
        await seedObservation({ retailRate: 12.5, legacyUsdToGhs: 15 });

        const route = await seedSavingsRoute(user.id, goal.id);
        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);
        expect(run.status).toBe('SUCCESS');

        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBeCloseTo(490, 5); // exactly one 10 USDC debit
        expect(Number(freshUser.escrowLockedBalance)).toBeCloseTo(10, 8);

        const deposits = await prisma.savingsDeposit.findMany({ where: { goalId: goal.id } });
        expect(deposits.length).toBe(1);
        expect(Number(deposits[0].amountUsdc)).toBeCloseTo(10, 5);
        expect(Number(deposits[0].amountGhs)).toBeCloseTo(125, 5);

        const ledgerTx = await prisma.ledgerTransaction.findMany({
            where: { metadata: { path: ['smartRouteRunId'], equals: run.id } },
        });
        expect(ledgerTx.length).toBe(1);

        // A crashed-execution re-drive of the same run CONVERGES to the
        // committed outcome (r16) and can never double-post: the guarded
        // PENDING/EXECUTING finalization claim admits exactly one winner.
        const reDrive = await svc._executeClaim(claim);
        expect(reDrive.status).toBe('SUCCESS');
        const freshUser2 = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser2.availableBalance)).toBeCloseTo(490, 5); // still exactly one debit
        const deposits2 = await prisma.savingsDeposit.findMany({ where: { goalId: goal.id } });
        expect(deposits2.length).toBe(1);
    });
});
