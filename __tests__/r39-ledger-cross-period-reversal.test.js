// __tests__/r39-ledger-cross-period-reversal.test.js
// =============================================================================
// r39/P1 — CROSS-PERIOD REVERSAL ACCOUNTING RULE (real PostgreSQL).
//
// The r37 wave made reversals net to zero INSIDE one period. This suite pins
// the durable rule when the reversal lands in a DIFFERENT reporting period
// than the original:
//
//   bucket value = Σ(INCOME amount) − Σ(non-INCOME amount)
//
//   • January expense -50, February reversal +50:
//       January reports +50 of expense (history retained),
//       February reports -50 of expense — a NEGATIVE expense, an explicit
//       correction that INCREASES February profit — never a fabricated +50
//       February expense (the old abs(sum) artifact),
//       cumulative (all-time) expenses net to exactly 0.
//   • INCOME reversals already followed the rule (signed sum as-is).
//   • expenseBreakdown reports the same negated signed net per category and
//     suppresses percentage shares over non-positive totals.
//   • the dashboard follows the same rule for its two windows.
//   • cash flow stays LITERAL signed flow (documented divergence).
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r39/P1 — cross-period reversal accounting rule', () => {
    let db;
    let svc;
    let bizId;

    const JAN = new Date('2026-01-15T12:00:00.000Z');
    const FEB = new Date('2026-02-15T12:00:00.000Z');

    const janWindow = { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-31T23:59:59.999Z' };
    const febWindow = { startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-02-28T23:59:59.999Z' };
    const allTime = { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-12-31T23:59:59.999Z' };

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
        svc.createEntry({ businessProfileId: bizId, type, category, description: 'r39', amount });

    const backdate = async (entryId, createdAt) =>
        db.businessLedgerEntry.update({ where: { id: entryId }, data: { createdAt } });

    describe('EXPENSE reversal in a later period', () => {
        test('January +50 expense, February -50 correction, cumulative 0', async () => {
            const orig = await entry('EXPENSE', 50, 'Fuel');
            await backdate(orig.id, JAN);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r39' });
            await backdate(reversal.id, FEB);

            const jan = await svc.getProfitLoss(bizId, janWindow);
            const feb = await svc.getProfitLoss(bizId, febWindow);
            const all = await svc.getProfitLoss(bizId, allTime);

            // January keeps the historical expense.
            expect(jan.totalExpenses).toBe(50);
            expect(jan.expenseByCategory.Fuel).toBe(50);
            expect(jan.byType.EXPENSE).toBe(50);

            // February reports the correction: a NEGATIVE expense, never a
            // fabricated +50. Profit moves UP by the corrected amount.
            expect(feb.totalExpenses).toBe(-50);
            expect(feb.expenseByCategory.Fuel).toBe(-50);
            expect(feb.byType.EXPENSE).toBe(-50);
            expect(feb.netProfit).toBe(50);

            // Cumulative reporting nets to exactly zero.
            expect(all.totalExpenses).toBe(0);
            expect(all.netProfit).toBe(0);
            expect(all.expenseByCategory.Fuel).toBe(0);
        });

        test('margin reflects the correction (no income → 0, with income → up)', async () => {
            const income = await entry('INCOME', 200, 'Sales');
            await backdate(income.id, FEB);
            const orig = await entry('EXPENSE', 50, 'Fuel');
            await backdate(orig.id, JAN);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r39' });
            await backdate(reversal.id, FEB);

            const feb = await svc.getProfitLoss(bizId, febWindow);
            expect(feb.totalIncome).toBe(200);
            expect(feb.totalExpenses).toBe(-50);
            expect(feb.netProfit).toBe(250);
            expect(feb.margin).toBe(125); // (200 - (-50)) / 200 * 100
        });
    });

    describe('INCOME reversal in a later period', () => {
        test('already-signed rule: February reports the negative income correction', async () => {
            const orig = await entry('INCOME', 80, 'Sales');
            await backdate(orig.id, JAN);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r39' });
            await backdate(reversal.id, FEB);

            const jan = await svc.getProfitLoss(bizId, janWindow);
            const feb = await svc.getProfitLoss(bizId, febWindow);
            const all = await svc.getProfitLoss(bizId, allTime);

            expect(jan.totalIncome).toBe(80);
            expect(feb.totalIncome).toBe(-80); // signed correction, not abs
            expect(all.totalIncome).toBe(0);
            expect(all.netProfit).toBe(0);
        });
    });

    describe('expenseBreakdown follows the same rule', () => {
        test('February category shows the negative correction; no percentage shares over a negative total', async () => {
            const orig = await entry('EXPENSE', 40, 'Fuel');
            await backdate(orig.id, JAN);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r39' });
            await backdate(reversal.id, FEB);

            const feb = await svc.getExpenseBreakdown(bizId, febWindow);
            expect(feb.totalExpenses).toBe(-40);
            const fuel = feb.categories.find(c => c.category === 'Fuel');
            expect(fuel.amount).toBe(-40);
            // Percentage shares are meaningless over a negative total.
            expect(feb.categories.every(c => c.percentage === 0)).toBe(true);

            const jan = await svc.getExpenseBreakdown(bizId, janWindow);
            expect(jan.totalExpenses).toBe(40);
            expect(jan.categories.find(c => c.category === 'Fuel').percentage).toBe(100);
        });
    });

    describe('dashboard windows follow the same rule', () => {
        test('current-period reversal reports a negative expense and raises profit', async () => {
            const orig = await entry('EXPENSE', 30, 'Fuel');
            await backdate(orig.id, JAN);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r39' });
            await backdate(reversal.id, FEB);

            const stats = await svc.getDashboardStats(bizId);
            // The dashboard compares the trailing windows; the exact window
            // membership depends on "now", so assert the invariant that
            // holds in every window composition: expenses are the negated
            // signed net, never abs().
            expect(stats.expenses.current).toBeLessThanOrEqual(0);
            expect(stats.profit.current).toBe(0 - stats.expenses.current + stats.revenue.current);
        });
    });

    describe('cash flow stays literal signed flow', () => {
        test('the reversal still posts its literal +50 inflow in February', async () => {
            const orig = await entry('EXPENSE', 50, 'Fuel');
            await backdate(orig.id, JAN);
            const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r39' });
            await backdate(reversal.id, FEB);

            const feb = await svc.getCashFlow(bizId, febWindow);
            // Literal signed flow: the February reversal posts its +50 as an
            // INFLOW row and drives the running balance to exactly +50 — the
            // flow report never applies the P&L expense negation.
            expect(feb.totalInflow).toBe(50);
            expect(feb.totalOutflow).toBe(0);
            expect(feb.entries[0].amount).toBe(50);
            expect(feb.entries[0].runningBalance).toBe(50);
        });
    });

    describe('_canonicalAmount delegates to the canonical parser (r39/P1)', () => {
        const post = (amount) => svc.createEntry({ businessProfileId: bizId, type: 'EXPENSE', category: 'Fuel', description: 'r39', amount });

        test('padded strings still parse (trimmed) — documented dine-in difference is preserved', async () => {
            const e = await post('  12.5  ');
            expect(Number(e.amount)).toBe(-12.5);
        });

        test('exponent strings are rejected — same rule as every canonical money rail', async () => {
            await expect(post('1e2')).rejects.toThrow(/non-negative exact decimal/);
        });

        test('fractional floats that are not exactly representable are rejected (0.00000001 as number)', async () => {
            await expect(post(0.00000001)).rejects.toThrow(/non-negative exact decimal/);
        });

        test('exact 8dp decimals survive end-to-end (string or exact float form)', async () => {
            const e = await post('0.12345678');
            expect(e.amount.toFixed(8)).toBe('-0.12345678');
            const e2 = await post(1.00000001); // String(1.00000001) round-trips exactly
            expect(e2.amount.toFixed(8)).toBe('-1.00000001');
        });

        test('negative magnitudes are refused (sign comes from the type, not the input)', async () => {
            await expect(post(-30)).rejects.toThrow(/non-negative exact decimal/);
        });

        test('zero is refused', async () => {
            await expect(post(0)).rejects.toThrow(/cannot be zero/);
        });
    });
});
