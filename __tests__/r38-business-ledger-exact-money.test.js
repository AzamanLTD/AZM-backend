// __tests__/r38-business-ledger-exact-money.test.js
// =============================================================================
// r38/P1 — EXACT MONEY in the manual business ledger (real PostgreSQL).
//
// BusinessLedgerEntry.amount is Decimal(20,8), but the manual POST path
// parsed amounts through Number()/Math.round(x*1e6) — silently quantizing to
// 6dp and losing binary exactness vs the stored decimal — and getCashFlow
// accumulated with parseFloat (0.1 + 0.2 → 0.30000000000000004).
//
// r38 converges the ledger on the SAME exact-decimal authority as the
// canonical platform ledger (end-to-end Prisma.Decimal, <= 8dp), while
// keeping the existing JSON envelope via deliberate serialization.
//
// Proofs:
//   • a legal 8dp amount (0.00000001) is stored AND returned exactly;
//   • > 8dp input is rejected (INVALID_AMOUNT), exponent strings rejected;
//   • 0.1 + 0.2 cash-flow aggregation reports exactly 0.3 (and a tiny
//     1e-8 row reports as 1e-8, not 0);
//   • reversal of an 8dp entry is the exact negation at full precision;
//   • expense reversal pairs net to exactly zero in cash flow;
//   • the sign still comes from the TYPE (positive magnitude input for an
//     EXPENSE is stored negative).
// =============================================================================
const { PrismaClient, Prisma } = require('@prisma/client');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r38/P1 — exact money in the manual business ledger', () => {
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
        svc.createEntry({ businessProfileId: bizId, type, category, description: 'r38', amount });

    // ── Exact storage + serialization ─────────────────────────────────────────

    test('legal 8dp income 0.00000001 → stored and returned exactly', async () => {
        const e = await entry('INCOME', '0.00000001');
        expect(new Prisma.Decimal(e.amount).toFixed(8)).toBe('0.00000001');
        const row = await db.businessLedgerEntry.findUnique({ where: { id: e.id } });
        expect(new Prisma.Decimal(row.amount).toFixed(8)).toBe('0.00000001');
    });

    test('8dp magnitudes never quantized: 12.34567890-ish values keep every digit they legally carry', async () => {
        const e = await entry('INCOME', '123.45678911');
        expect(new Prisma.Decimal(e.amount).toFixed(8)).toBe('123.45678911');
    });

    test('expense magnitude input → stored NEGATIVE (sign comes from the type), exact', async () => {
        const e = await entry('EXPENSE', '0.00000001');
        expect(new Prisma.Decimal(e.amount).toFixed(8)).toBe('-0.00000001');
    });

    // ── Strict rejection ──────────────────────────────────────────────────────

    test('> 8dp input → 400 INVALID_AMOUNT, zero mutation', async () => {
        await expect(entry('INCOME', '0.123456789')).rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
        await expect(entry('INCOME', '12.000000001')).rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
        expect(await db.businessLedgerEntry.count()).toBe(0);
    });

    test('exponent-notation strings rejected (same exactness authority as the canonical ledger)', async () => {
        await expect(entry('INCOME', '1e-8')).rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
        await expect(entry('INCOME', '1e5')).rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
        await expect(entry('INCOME', 'NaN')).rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
        expect(await db.businessLedgerEntry.count()).toBe(0);
    });

    // ── Exact cash-flow aggregation ─────────────────────────────────────────

    test('0.1 + 0.2 inflow → totalInflow exactly 0.3, not 0.30000000000000004', async () => {
        await entry('INCOME', '0.1');
        await entry('INCOME', '0.2');
        const cash = await svc.getCashFlow(bizId, {});
        expect(cash.totalInflow).toBe(0.3);
        expect(cash.netFlow).toBe(0.3);
        expect(cash.entries[1].runningBalance).toBe(0.3);
        expect(cash.dailyFlow[0].inflow).toBe(0.3);
    });

    test('a tiny 1e-8 income row reports as 1e-8, never rounds to 0', async () => {
        await entry('INCOME', '0.00000001');
        const cash = await svc.getCashFlow(bizId, {});
        expect(cash.totalInflow).toBe(1e-8);
        expect(cash.netFlow).toBe(1e-8);
    });

    test('mixed 8dp ledger sums exactly (no float artifacts anywhere in the envelope)', async () => {
        await entry('INCOME', '0.00000001');
        await entry('EXPENSE', '0.00000002');
        await entry('INCOME', '1234.56789012');
        const cash = await svc.getCashFlow(bizId, {});
        // exact expected: 1234.56789012 + 0.00000001 - 0.00000002
        expect(new Prisma.Decimal(cash.netFlow).toFixed(8)).toBe('1234.56789011');
        expect(cash.entries[2].runningBalance).toBe(1234.56789011);
    });

    // ── Reversal precision ────────────────────────────────────────────────────

    test('reversal of an 8dp entry is the EXACT negation at full precision', async () => {
        const orig = await entry('INCOME', '7.12345678');
        const { reversal } = await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r38' });
        expect(new Prisma.Decimal(reversal.amount).toFixed(8)).toBe('-7.12345678');
        const cash = await svc.getCashFlow(bizId, {});
        expect(cash.netFlow).toBe(0);
        expect(cash.totalInflow).toBe(7.12345678);
    });

    test('expense reversal pair nets to exactly zero in cash flow (Decimal sum, not float)', async () => {
        const orig = await entry('EXPENSE', '0.1', 'Fuel');
        await svc.createReversalEntry({ businessProfileId: bizId, entryId: orig.id, reason: 'r38' });
        const cash = await svc.getCashFlow(bizId, {});
        expect(cash.netFlow).toBe(0);
        // The outflow bucket carries the expense, the +0.1 reversal lands in
        // inflow; the NET is exactly zero — the aggregation semantic of r37
        // is preserved, only the arithmetic became exact.
        expect(cash.totalOutflow).toBe(0.1);
        expect(cash.totalInflow).toBe(0.1);
    });

    // ── Aggregation layers stay consistent ─────────────────────────────────────

    test('expense breakdown and P&L report exact 8dp values', async () => {
        await entry('EXPENSE', '0.00000003', 'Fuel');
        const breakdown = await svc.getExpenseBreakdown(bizId, {});
        const fuel = breakdown.categories.find((c) => c.category === 'Fuel');
        expect(fuel.amount).toBe(3e-8);
        const pl = await svc.getProfitLoss(bizId, {});
        expect(pl.totalExpenses).toBe(3e-8);
        expect(pl.netProfit).toBe(-3e-8);
    });
});
