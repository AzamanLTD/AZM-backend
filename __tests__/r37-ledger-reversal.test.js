// __tests__/r37-ledger-reversal.test.js
// =============================================================================
// r37/P1 — BUSINESS LEDGER REVERSAL: durable uniqueness + EXPENSE accounting
// (real PostgreSQL).
//
// Two holes closed here:
//   • CONCURRENCY: createReversalEntry was read-check-create inside a
//     transaction — two simultaneous reversals both observed "no reversal
//     yet" and BOTH wrote one. The durable invariant is now a UNIQUE index
//     on BusinessLedgerEntry.reversalOfId: exactly one insert wins, the
//     loser fails closed (409) with zero mutation.
//   • ACCOUNTING: the P&L aggregated every non-INCOME row through
//     Math.abs(amount). An EXPENSE of -50 plus its reversal of +50 reported
//     100 of expense instead of 0. The canonical aggregation is now SIGNED:
//     reversals net to zero INSIDE their bucket, across getProfitLoss,
//     getExpenseBreakdown, getDashboardStats and cash flow.
//   • CHAINS: a reversal may never itself be reversed (double economics).
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r37/P1 — ledger reversal concurrency + expense accounting', () => {
    let db;
    let svc;
    let bizId;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        svc = new BusinessLedgerService(db);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "BusinessLedgerEntry", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        const { biz } = await seedBusiness(db);
        bizId = biz.id;
    });

    const entry = (type, amount, category = 'Test') =>
        svc.createEntry({ businessProfileId: bizId, type, category, description: 'r37', amount });

    // ── EXPENSE-class reversal accounting ────────────────────────────────────

    describe.each([
        ['EXPENSE', 'Fuel'],
        ['PAYROLL', 'Salaries'],
        ['TAX', 'VAT'],
    ])('%s reversal nets to zero in every aggregation', (type, category) => {
        test(`${type} -50 + reversal +50 → total expense 0, byType/byCategory 0, net profit unchanged`, async () => {
            const before = await svc.getProfitLoss(bizId, {});
            const orig = await entry(type, 50, category);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r37' });

            expect(Number(reversal.amount)).toBe(50); // exact negation of -50
            expect(reversal.reversalOfId).toBe(orig.id);

            const pl = await svc.getProfitLoss(bizId, {});
            expect(pl.totalIncome).toBeCloseTo(before.totalIncome, 6);
            expect(pl.totalExpenses).toBeCloseTo(before.totalExpenses, 6); // 0 extra expense
            expect(pl.netProfit).toBeCloseTo(before.netProfit, 6);
            expect(pl.byType[type] || 0).toBeCloseTo(0, 6);
            expect(pl.byCategory[category] || 0).toBeCloseTo(0, 6);
            expect(pl.expenseByCategory[category] || 0).toBeCloseTo(0, 6);

            const cash = await svc.getCashFlow(bizId, {});
            expect(cash.netFlow).toBeCloseTo(0, 6); // net economic effect zero

            const breakdown = await svc.getExpenseBreakdown(bizId, {});
            const cat = breakdown.categories.find((c) => c.category === category);
            expect(cat ? cat.amount : 0).toBeCloseTo(0, 6);

            const stats = await svc.getDashboardStats(bizId);
            expect(stats.expenses.current).toBeCloseTo(0, 6);
            expect(stats.profit.current).toBeCloseTo(0, 6);
        });
    });

    test('INCOME reversal still nets (income bucket unchanged)', async () => {
        const orig = await entry('INCOME', 80, 'Sales');
        await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id });
        const pl = await svc.getProfitLoss(bizId, {});
        expect(pl.totalIncome).toBeCloseTo(0, 6);
        expect(pl.byType.INCOME).toBeCloseTo(0, 6);
        expect(pl.incomeByCategory.Sales).toBeCloseTo(0, 6);
        expect(pl.netProfit).toBeCloseTo(0, 6);
    });

    test('mixed book: only the reversed expense nets; others stay gross', async () => {
        await entry('INCOME', 200, 'Sales');
        const fuel = await entry('EXPENSE', 50, 'Fuel');
        await entry('EXPENSE', 30, 'Supplies');
        await svc.createReversalEntry({ businessProfileId: bizId, entryId: fuel.id });
        const pl = await svc.getProfitLoss(bizId, {});
        expect(pl.totalIncome).toBeCloseTo(200, 6);
        expect(pl.totalExpenses).toBeCloseTo(30, 6);
        expect(pl.netProfit).toBeCloseTo(170, 6);
        expect(pl.byType.EXPENSE).toBeCloseTo(30, 6);
        expect(pl.byCategory.Fuel).toBeCloseTo(0, 6);
        expect(pl.byCategory.Supplies).toBeCloseTo(30, 6);
    });

    // ── Reversal identity ────────────────────────────────────────────────────

    test('original row is immutable: second reversal attempt refused, zero mutation', async () => {
        const orig = await entry('EXPENSE', 50, 'Fuel');
        const before = await db.businessLedgerEntry.findUnique({ where: { id: orig.id } });
        const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id });
        const after = await db.businessLedgerEntry.findUnique({ where: { id: orig.id } });
        expect(Number(after.amount)).toBe(Number(before.amount));
        expect(after.category).toBe(before.category);
        expect(after.description).toBe(before.description);

        await expect(svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id }))
            .rejects.toMatchObject({ status: 409, code: 'ALREADY_REVERSED' });
        // Still exactly one reversal row.
        const rows = await db.businessLedgerEntry.findMany({ where: { businessProfileId: bizId, reversalOfId: orig.id } });
        expect(rows.length).toBe(1);
        expect(reversal.metadata.reversal).toBe(true);
        expect(reversal.metadata.reversalOf).toBe(orig.id);
    });

    test('reversal of a reversal is rejected (never chains)', async () => {
        const orig = await entry('EXPENSE', 50, 'Fuel');
        const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id });
        await expect(svc.createReversalEntry({ businessProfileId: bizId, entryId: reversal.id }))
            .rejects.toMatchObject({ status: 409, code: 'NOT_REVERSIBLE' });
        // deleteEntry (public route path) on a reversal is refused too.
        await expect(svc.deleteEntry(reversal.id, bizId, 'chain attempt'))
            .rejects.toMatchObject({ code: 'NOT_REVERSIBLE' });
        const rows = await db.businessLedgerEntry.findMany({ where: { businessProfileId: bizId } });
        expect(rows.length).toBe(2); // original + one reversal — no chain
    });

    test('cross-tenant reversal refused', async () => {
        const other = await seedBusiness(db);
        const orig = await entry('EXPENSE', 50, 'Fuel');
        await expect(svc.createReversalEntry({ businessProfileId: other.biz.id, entryId: orig.id }))
            .rejects.toMatchObject({ status: 404 });
    });

    // ── CONCURRENCY PROOF ───────────────────────────────────────────────────

    test('two simultaneous reversals → exactly one row, one economic effect, deterministic loser', async () => {
        const orig = await entry('EXPENSE', 50, 'Fuel');
        const results = await Promise.allSettled([
            svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r1' }),
            svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r2' }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason).toMatchObject({ status: 409, code: 'ALREADY_REVERSED' });

        const reversals = await db.businessLedgerEntry.findMany({ where: { businessProfileId: bizId, reversalOfId: orig.id } });
        expect(reversals.length).toBe(1);
        // Exactly one economic effect: expense bucket nets to zero.
        const pl = await svc.getProfitLoss(bizId, {});
        expect(pl.totalExpenses).toBeCloseTo(0, 6);
    });

    test('eight simultaneous reversals → still exactly one', async () => {
        const orig = await entry('INCOME', 50, 'Sales');
        const results = await Promise.allSettled(
            Array.from({ length: 8 }, (_, i) =>
                svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: `c${i}` }))
        );
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const reversals = await db.businessLedgerEntry.findMany({ where: { businessProfileId: bizId, reversalOfId: orig.id } });
        expect(reversals.length).toBe(1);
        const pl = await svc.getProfitLoss(bizId, {});
        expect(pl.totalIncome).toBeCloseTo(0, 6);
    });
});
