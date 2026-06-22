// __tests__/savings-flow.test.js
// =============================================================================
// Savings flow integration tests
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
// Adapted to the ACTUAL controllers/savingsController.js (verified, NOT the
// design-doc shapes):
//   • createGoal reads { name, targetAmountGhs, frequencyAmount, frequency,
//     endDate, isLocked } and returns HTTP 201.
//   • deposit reads { amountGhs, type, clientRequestId } — idempotency is keyed
//     by clientRequestId (NOT a body `idempotencyKey`), and it reads
//     req.headers, so every req must carry a headers object.
//   • The GHS→USDC rate is settings.liveUsdToGhs, defaulting to 15.0 when no
//     GlobalSettings row exists — so we deliberately do NOT seed one.
//   • Early-withdrawal penalty routes to SystemProfitFees (upsert id:1) AND an
//     AdminProfitLog SAVINGS_FEE row. A full withdraw flips status → CANCELLED,
//     and a withdraw on a CANCELLED goal is rejected with 400.
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedSavingsGoal, seedUser } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[savings-flow.test] TEST_DATABASE_URL not set — skipping.');

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
        // suite can't bleed in — with no row, the controller uses its documented
        // 15.0 GHS/USDC fallback, which the assertions below rely on.
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User","SavingsGoal","SavingsDeposit",' +
            '"TransactionHistory","SystemProfitFees","GlobalSettings" RESTART IDENTITY CASCADE'
        );
    });

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
});
