// __tests__/savings-flow.test.js
// =============================================================================
// Savings flow integration tests (real PostgreSQL)
//
// Covers:
//   A. createGoal: creates an ACTIVE goal (HTTP 201)
//   B. deposit: debits availableBalance, credits currentAmountGhs, idempotent
//      via clientRequestId
//   C. withdraw (no penalty): matured (endDate in the past) — net refund, no fee
//   D. withdraw (early penalty): isLocked + not matured — penalty deducted from
//      refund and routed to the SystemProfitFees singleton
//   E. duplicate withdraw is rejected (goal already CANCELLED after a full pull)
//
// §271 quote-backed savings (this PR): a savings deposit/withdrawal converts
// GHS↔USDC, so it is a market-priced operation. The conversion rate now comes
// from the ONE shared TransactionQuote authority:
//   F. deposit/withdraw responses carry the quote provenance
//      (quotedRate / rateSource / rateAsOf / quoteId); the money row keeps
//      durable metadata.quoteId
//   G. the quoted rate is the ONLY rate that moves money — the TransactionQuote
//      row is consumed exactly-once inside the economic transaction
//   H. STALE external rate → deposit AND withdraw fail closed 503
//      (RATE_STALE), nothing moves, no quote row is created
//   I. pesewa precision: sub-pesewa inputs round HALF_UP to the pesewa like
//      every other GHS settlement (10.005 → 10.01) — the quote's pesewa
//      amount is what reaches the goal arithmetic
//   J. withdraw-all: legacy sub-pesewa goal residue (< half a pesewa) is
//      absorbed as dust and the goal fully drains
//
// Seeding: the quote gate requires a FRESH external observation, so every
// test seeds GlobalSettings (liveRetailRate 15.0, lastExternalSync ≈ now).
// Tests never seed the row directly inside the controller — the quote
// service's gate is the only reader.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedSavingsGoal, seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[savings-flow.test] TEST_DATABASE_URL not set — skipping.');

// TransactionQuote lives outside the generated Prisma client (raw-SQL table)
// — read it through $queryRaw.
const getQuoteRows = (prisma, userId) =>
    prisma.$queryRawUnsafe(
        'SELECT "purpose", "amountGhs", "consumedAt", "rateGhsPerUsdc" FROM "TransactionQuote" WHERE "userId" = $1 ORDER BY "createdAt"',
        userId
    );

describeOrSkip('Savings flow', () => {
    let prisma, ctrl;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ctrl   = require('../controllers/savingsController');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        // GlobalSettings is included so a leftover liveUsdToGhs row from another
        // suite can't bleed in; TransactionQuote is included so unconsumed
        // quotes from a failed request never leak into later assertions.
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User","SavingsGoal","SavingsDeposit",' +
            '"TransactionHistory","SystemProfitFees","GlobalSettings","TransactionQuote","LedgerAccount","AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // Fresh external observation at 15.0 GHS/USDC — the quote gate accepts
    // exactly this shape (liveRetailRate + fresh lastExternalSync).
    const seedFreshRate = async (prisma, { ageSeconds = 0, retail = 15.0 } = {}) => {
        const observed = new Date(Date.now() - ageSeconds * 1000);
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: retail,
                liveUsdToGhs: retail,
                lastExternalSync: observed,
                lastRateSync: observed,
                liveRateSource: 'KOTANI_PAY',
            },
            create: {
                id: 1,
                liveRetailRate: retail,
                liveUsdToGhs: retail,
                lastExternalSync: observed,
                lastRateSync: observed,
                liveRateSource: 'KOTANI_PAY',
            },
        });
    };

    function res() {
        const r = { _status: 200, _body: null };
        r.status = (s) => { r._status = s; return r; };
        r.json   = (b) => { r._body  = b; return r; };
        return r;
    }
    // app.get('prisma') returns the test client; every other key (emitBalanceUpdate,
    // notificationService, ...) resolves to null so the controller's optional
    // hooks are skipped.
    function app(p) { return { get: (k) => (k === 'prisma' ? p : null) }; }

    // ── A. createGoal ──────────────────────────────────────────────────────────
    test('A: createGoal creates an ACTIVE savings goal', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const r = res();
        await ctrl.createGoal(
            {
                user: { id: user.id },
                headers: {},
                body: {
                    name: 'Ghana Trip Fund',
                    targetAmountGhs: 1000,
                    frequencyAmount: 100,
                    frequency: 'WEEKLY',
                    endDate: new Date(Date.now() + 90 * 86400000).toISOString(),
                    isLocked: true,
                },
                app: app(prisma),
            },
            r
        );
        expect(r._status).toBe(201);
        expect(r._body.success).toBe(true);
        const goal = await prisma.savingsGoal.findFirst({ where: { userId: user.id } });
        expect(goal).not.toBeNull();
        expect(goal.status).toBe('ACTIVE');
    });

    // ── B. deposit — happy path and idempotency ────────────────────────────────
    test('B1: deposit debits availableBalance and credits currentAmountGhs', async () => {
        await seedFreshRate(prisma);
        const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 500 } });
        const r = res();
        await ctrl.deposit(
            {
                user:    { id: user.id },
                params:  { id: String(goal.id) },
                headers: {},
                body:    { amountGhs: 150 },
                app:     app(prisma),
            },
            r
        );
        expect(r._status).toBe(200);
        expect(r._body.success).toBe(true);

        const updated = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(updated.availableBalance)).toBeLessThan(500);
        const g = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(g.currentAmountGhs)).toBeGreaterThan(0);
    });

    test('B2: duplicate deposit with same clientRequestId is a no-op', async () => {
        await seedFreshRate(prisma);
        const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 500 } });
        const clientRequestId = `IDEM_TEST_${user.id}_${goal.id}`;
        const req = () => ({
            user:    { id: user.id },
            params:  { id: String(goal.id) },
            headers: {},
            body:    { amountGhs: 100, clientRequestId },
            app:     app(prisma),
        });

        const r1 = res(); await ctrl.deposit(req(), r1);
        expect(r1._status).toBe(200);
        const balAfterFirst = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const r2 = res(); await ctrl.deposit(req(), r2);
        expect(r2._status).toBe(200); // idempotent replay, not an error
        const balAfterSecond = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        expect(balAfterSecond).toBe(balAfterFirst); // no second deduction
    });

    // ── C. withdraw (no penalty — matured goal) ────────────────────────────────
    test('C: withdraw from a matured goal returns funds with no penalty', async () => {
        await seedFreshRate(prisma);
        const pastEnd = new Date(Date.now() - 86400000); // matured yesterday
        const { user, goal } = await seedSavingsGoal(prisma, {
            user: { availableBalance: 0 },
            goal: { currentAmountGhs: 200, targetAmountGhs: 200, endDate: pastEnd, isLocked: true },
        });
        const balBefore = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const r = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 200 }, app: app(prisma) },
            r
        );
        expect(r._status).toBe(200);

        const balAfter = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        expect(balAfter).toBeGreaterThan(balBefore);
        // No penalty row for a matured withdrawal.
        const profits = await prisma.systemProfitFees.findFirst();
        if (profits) {
            expect(Number(profits.balance)).toBe(0);
        }
    });

    // ── D. early withdraw penalty ──────────────────────────────────────────────
    test('D: early withdraw deducts penalty and routes it to SystemProfitFees', async () => {
        await seedFreshRate(prisma);
        // isLocked + future/open endDate → early withdrawal → penalty applies.
        const { user, goal } = await seedSavingsGoal(prisma, {
            user: { availableBalance: 0 },
            goal: {
                currentAmountGhs: 300,
                targetAmountGhs: 300,
                earlyWithdrawalPenalty: 0.05,
                endDate: new Date(Date.now() + 60 * 86400000), // not matured
                isLocked: true,
            },
        });

        const r = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 300 }, app: app(prisma) },
            r
        );
        expect(r._status).toBe(200);

        const balAfter = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        // 300 GHS @ 15 GHS/USDC = 20 USDC; 5% penalty = 1 USDC; net ≈ 19 USDC.
        expect(balAfter).toBeGreaterThan(0);
        expect(balAfter).toBeLessThan(20); // penalty was applied

        const profits = await prisma.systemProfitFees.findFirst();
        expect(profits).not.toBeNull();
        expect(Number(profits.balance)).toBeGreaterThan(0);
    });

    // ── E. double-withdraw rejected ────────────────────────────────────────────
    test('E: second withdraw on a fully-withdrawn goal is rejected', async () => {
        await seedFreshRate(prisma);
        const pastEnd = new Date(Date.now() - 86400000);
        const { user, goal } = await seedSavingsGoal(prisma, {
            user: { availableBalance: 0 },
            goal: { currentAmountGhs: 100, targetAmountGhs: 100, endDate: pastEnd, isLocked: true },
        });

        const r1 = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 100 }, app: app(prisma) },
            r1
        );
        expect(r1._status).toBe(200);
        const balAfterFirst = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

        const r2 = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 100 }, app: app(prisma) },
            r2
        );
        expect(r2._status).not.toBe(200); // goal is CANCELLED → rejected
        const balAfterSecond = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        expect(balAfterSecond).toBe(balAfterFirst); // no double-credit
    });

    // ── F. quote provenance surfaces on both operations ────────────────────────
    test('F: deposit and withdraw responses carry the quote provenance', async () => {
        await seedFreshRate(prisma);
        const pastEnd = new Date(Date.now() - 86400000);
        const { user, goal } = await seedSavingsGoal(prisma, {
            user: { availableBalance: 200 },
            goal: { currentAmountGhs: 150, targetAmountGhs: 1000, endDate: pastEnd, isLocked: true },
        });

        const r1 = res();
        await ctrl.deposit(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 100 }, app: app(prisma) },
            r1
        );
        expect(r1._status).toBe(200);
        expect(r1._body.data.quotedRate).toBe(15);
        expect(r1._body.data.rateSource).toBe('KOTANI_PAY');
        expect(r1._body.data.rateAsOf).toBeDefined();
        expect(typeof r1._body.data.quoteId).toBe('string');
        const depositQuoteId = r1._body.data.quoteId;

        // The money row keeps durable quote provenance for audit.
        const dep = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'INTERNAL_TRANSFER' },
            orderBy: { id: 'desc' },
        });
        const depMeta = typeof dep.metadata === 'string' ? JSON.parse(dep.metadata) : dep.metadata;
        expect(depMeta.quoteId).toBe(depositQuoteId);
        expect(depMeta.quotedRate).toBe(15);

        const r2 = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 250 }, app: app(prisma) },
            r2
        );
        expect(r2._status).toBe(200);
        expect(r2._body.data.quotedRate).toBe(15);
        expect(typeof r2._body.data.quoteId).toBe('string');
    });

    // ── G. quote consumed exactly-once, inside the economic transaction ───────
    test('G: a successful savings operation consumes its quote exactly once', async () => {
        await seedFreshRate(prisma);
        const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 500 } });

        const r = res();
        await ctrl.deposit(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 100 }, app: app(prisma) },
            r
        );
        expect(r._status).toBe(200);

        const rows = await getQuoteRows(prisma, user.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].purpose).toBe('savings_deposit');
        expect(Number(rows[0].amountGhs)).toBe(100);
        expect(rows[0].consumedAt).not.toBeNull(); // consumed with the money
    });

    // ── H. stale external rate fails closed (deposit AND withdraw) ─────────────
    test('H: stale rate → 503 RATE_STALE, no money moves, no quote created', async () => {
        await seedFreshRate(prisma, { ageSeconds: 2400 }); // beyond the 1800s gate
        const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 500 } });

        const r1 = res();
        await ctrl.deposit(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 100 }, app: app(prisma) },
            r1
        );
        expect(r1._status).toBe(503);
        expect(r1._body.code).toBe('RATE_STALE');

        const r2 = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 100 }, app: app(prisma) },
            r2
        );
        expect(r2._status).toBe(503);
        expect(r2._body.code).toBe('RATE_STALE');

        // Fail-closed: NOTHING moved and no quote row was persisted.
        const bal = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        expect(bal).toBe(500);
        const g = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(g.currentAmountGhs)).toBe(0);
        const quotes = await getQuoteRows(prisma, user.id);
        expect(quotes).toHaveLength(0);
    });

    // ── I. pesewa precision — sub-pesewa inputs round HALF_UP to the pesewa ────
    test('I: deposit of GHS 10.005 settles at the pesewa-rounded 10.01', async () => {
        await seedFreshRate(prisma);
        const { user, goal } = await seedSavingsGoal(prisma, { user: { availableBalance: 500 } });

        const r = res();
        await ctrl.deposit(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: { amountGhs: 10.005 }, app: app(prisma) },
            r
        );
        expect(r._status).toBe(200);

        // The quote's pesewa amount (HALF_UP → 10.01) is what moves
        // everywhere — goal arithmetic included.
        const g = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(g.currentAmountGhs)).toBeCloseTo(10.01, 4);
        const dep = await prisma.savingsDeposit.findFirst({ where: { goalId: goal.id } });
        expect(Number(dep.amountGhs)).toBeCloseTo(10.01, 4);
    });

    // ── J. withdraw-all absorbs legacy sub-pesewa residue as dust ─────────────
    test('J: withdraw-all drains a goal with sub-pesewa legacy residue', async () => {
        await seedFreshRate(prisma);
        const { user, goal } = await seedSavingsGoal(prisma, {
            user: { availableBalance: 0 },
            goal: { currentAmountGhs: 10.005, targetAmountGhs: 20 }, // legacy float residue
        });

        const r = res();
        await ctrl.withdraw(
            { user: { id: user.id }, params: { id: String(goal.id) }, headers: {}, body: {}, app: app(prisma) },
            r
        );
        expect(r._status).toBe(200);

        // The dust (< half a pesewa) is absorbed and the goal fully drains.
        const g = await prisma.savingsGoal.findUnique({ where: { id: goal.id } });
        expect(Number(g.currentAmountGhs)).toBe(0);
        expect(g.status).toBe('CANCELLED');
        const bal = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
        expect(bal).toBeGreaterThan(0);
    });
});
