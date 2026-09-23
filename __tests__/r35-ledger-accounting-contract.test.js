// __tests__/r35-ledger-accounting-contract.test.js
// =============================================================================
// r35/P2 — BUSINESS LEDGER ACCOUNTING CONTRACT (real PostgreSQL, real HTTP).
//
// The contract, now enforced rather than implied:
//   • signed amounts: INCOME stored positive, every other type stored
//     negative — the TYPE is authoritative, not the client's sign (the
//     portal's manual-entry form sends positive expense amounts, which used
//     to be stored as-is and inverted cash-flow math);
//   • append-only: DELETE /ledger/:id writes an exact negating REVERSAL that
//     references the original (metadata.reversalOf) — the original row is
//     never removed or mutated, for manual AND settlement rows;
//   • one reversal per entry: a second attempt is refused (409), zero
//     mutation;
//   • cross-tenant reversal/delete refused (404), zero mutation;
//   • validation: invalid type / NaN / zero / oversized amounts rejected,
//     zero mutation;
//   • a reversed pair nets zero in P&L and cash flow.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R35_LEDGER_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { BusinessLedgerService } = require('../services/businessOS/businessLedgerService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r35/P2 — business ledger accounting contract', () => {
    let db;
    let app;
    let A, B;
    let seq = 0;

    const buildApp = () => {
        const a = express();
        a.use(express.json());
        a.set('prisma', db);
        a.set('logger', { error: () => {}, warn: () => {} });
        a.use('/api/business-os', businessOSRoutes);
        return a;
    };

    const asUser = (user) => { global.__R35_LEDGER_USER__ = user ? { id: user.id } : null; };
    const postEntry = (body) => request(app).post('/api/business-os/ledger').send(body);
    const deleteEntry = (id, body) => request(app).delete(`/api/business-os/ledger/${id}`).send(body || {});
    const pnl = () => request(app).get('/api/business-os/ledger/profit-loss');
    const cashFlow = () => request(app).get('/api/business-os/ledger/cash-flow');

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = buildApp();
    });
    afterAll(async () => { await db.$disconnect(); });

    afterEach(async () => {
        global.__R35_LEDGER_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "BusinessLedgerEntry", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        asUser(A.owner);
    });

    test('1. sign convention: TYPE is authoritative — EXPENSE stored negative, INCOME positive', async () => {
        // The portal form sends a POSITIVE expense amount — must land negative.
        const expense = await postEntry({ type: 'EXPENSE', category: 'Fuel', description: 'diesel', amount: 50 });
        expect(expense.status).toBe(201);
        expect(Number(expense.body.entry.amount)).toBe(-50);
        // Even a client-signed negative expense normalizes to the same row.
        const expense2 = await postEntry({ type: 'EXPENSE', category: 'Fuel', description: 'diesel2', amount: -30 });
        expect(Number(expense2.body.entry.amount)).toBe(-30);
        // Income positive regardless of client sign.
        const income = await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale', amount: 100 });
        expect(Number(income.body.entry.amount)).toBe(100);
        const income2 = await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale2', amount: -25 });
        expect(Number(income2.body.entry.amount)).toBe(25);
        // All other debit types normalize negative too.
        for (const t of ['PAYROLL', 'TAX', 'REFUND', 'PENALTY', 'AD_SPEND']) {
            const res = await postEntry({ type: t, category: 'c', description: 'd', amount: 10 });
            expect(res.status).toBe(201);
            expect(Number(res.body.entry.amount)).toBe(-10);
        }
    });

    test('2. cash-flow math is correct under the signed convention', async () => {
        await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale', amount: 100 });
        await postEntry({ type: 'EXPENSE', category: 'Fuel', description: 'fuel', amount: 40 });
        const res = await cashFlow();
        expect(res.status).toBe(200);
        const cf = res.body.cf;
        expect(Number(cf.totalInflow)).toBe(100);
        expect(Number(cf.totalOutflow)).toBe(40);
        expect(Number(cf.netFlow)).toBe(60);
        expect(Number(cf.endingBalance)).toBe(60);
        // The expense REDUCED the running balance (the legacy positive-expense
        // bug raised it instead).
        const balances = cf.entries.map((e) => Number(e.runningBalance));
        expect(balances).toEqual([100, 60]);
    });

    test('3. P&L math is exact under the signed convention', async () => {
        await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale', amount: 100.5 });
        await postEntry({ type: 'EXPENSE', category: 'Fuel', description: 'fuel', amount: 40.25 });
        const res = await pnl();
        expect(res.status).toBe(200);
        const pl = res.body.pl;
        expect(Number(pl.totalIncome)).toBeCloseTo(100.5, 6);
        expect(Number(pl.totalExpenses)).toBeCloseTo(40.25, 6);
        expect(Number(pl.netProfit)).toBeCloseTo(60.25, 6);
    });

    test('4. reversal writes an exact negation that references the original', async () => {
        const entry = await postEntry({ type: 'INCOME', category: 'Sales', description: 'wrong sale', amount: 80 });
        const original = entry.body.entry;
        const svc = new BusinessLedgerService(db);
        const { reversal } = await svc.createReversalEntry({ businessProfileId: A.biz.id, entryId: original.id, reason: 'bookkeeping error' });
        expect(Number(reversal.amount)).toBeCloseTo(-80, 6);
        expect(reversal.metadata.reversalOf).toBe(original.id);
        expect(reversal.metadata.reversalReason).toBe('bookkeeping error');
        expect(reversal.type).toBe('INCOME');
        // The original row is untouched — append-only.
        const orig = await db.businessLedgerEntry.findUnique({ where: { id: original.id } });
        expect(Number(orig.amount)).toBeCloseTo(80, 6);
        expect(orig.description).toBe('wrong sale');
        // The pair nets exactly zero.
        const rows = await db.businessLedgerEntry.findMany({ where: { businessProfileId: A.biz.id } });
        const net = rows.reduce((s, r) => s + Number(r.amount), 0);
        expect(net).toBeCloseTo(0, 6);
    });

    test('5. second reversal of the same entry is refused with zero mutation', async () => {
        const entry = await postEntry({ type: 'EXPENSE', category: 'Fuel', description: 'fuel', amount: 20 });
        const original = entry.body.entry;
        const svc = new BusinessLedgerService(db);
        await svc.createReversalEntry({ businessProfileId: A.biz.id, entryId: original.id });
        await expect(svc.createReversalEntry({ businessProfileId: A.biz.id, entryId: original.id }))
            .rejects.toMatchObject({ status: 409, code: 'ALREADY_REVERSED' });
        // Still exactly two rows — no second economic mutation.
        expect(await db.businessLedgerEntry.count({ where: { businessProfileId: A.biz.id } })).toBe(2);
    });

    test('6. DELETE route is append-only: original survives, negating twin exists, net zero', async () => {
        const entry = await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale', amount: 60 });
        const originalId = entry.body.entry.id;
        const res = await deleteEntry(originalId, { reason: 'oops' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // The original row still exists (no hard delete anywhere).
        const original = await db.businessLedgerEntry.findUnique({ where: { id: originalId } });
        expect(original).toBeTruthy();
        expect(Number(original.amount)).toBeCloseTo(60, 6);
        // And a negating twin references it.
        const twin = await db.businessLedgerEntry.findFirst({ where: { businessProfileId: A.biz.id, metadata: { path: ['reversalOf'], equals: originalId } } });
        expect(twin).toBeTruthy();
        expect(Number(twin.amount)).toBeCloseTo(-60, 6);
        // Net zero.
        const rows = await db.businessLedgerEntry.findMany({ where: { businessProfileId: A.biz.id } });
        expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(0, 6);
    });

    test('6b. a reversed pair nets zero in P&L and cash flow', async () => {
        await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale', amount: 100 });
        await postEntry({ type: 'EXPENSE', category: 'Fuel', description: 'fuel', amount: 30 });
        const entry = await postEntry({ type: 'INCOME', category: 'Sales', description: 'wrong sale', amount: 70 });
        await deleteEntry(entry.body.entry.id);
        // INCOME rows: +100, +70, -70 (the reversal is a contra-income row).
        // The +70/-70 pair contributes exactly zero to every aggregate.
        const pl = (await pnl()).body.pl;
        expect(Number(pl.totalIncome)).toBeCloseTo(100, 6);
        expect(Number(pl.totalExpenses)).toBeCloseTo(30, 6);
        expect(Number(pl.netProfit)).toBeCloseTo(70, 6);
        const cf = (await cashFlow()).body.cf;
        expect(Number(cf.endingBalance)).toBeCloseTo(70, 6);
        expect(Number(cf.netFlow)).toBeCloseTo(70, 6);
    });

    test('7. cross-tenant delete is refused with zero mutation', async () => {
        const entry = await postEntry({ type: 'INCOME', category: 'Sales', description: 'sale', amount: 90 });
        const originalId = entry.body.entry.id;
        asUser(B.owner);
        const res = await deleteEntry(originalId);
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        // Nothing reversed, nothing deleted.
        expect(await db.businessLedgerEntry.count({ where: { businessProfileId: A.biz.id } })).toBe(1);
        expect(await db.businessLedgerEntry.count({ where: { businessProfileId: B.biz.id } })).toBe(0);
    });

    test('8. validation fails closed with zero mutation', async () => {
        for (const bad of [
            { type: 'NOT_A_TYPE', category: 'c', description: 'd', amount: 10 },
            { type: 'EXPENSE', category: 'c', description: 'd', amount: 'abc' },
            { type: 'EXPENSE', category: 'c', description: 'd', amount: 0 },
            { type: 'EXPENSE', category: 'c', description: 'd', amount: 1e12 },
            { type: 'EXPENSE', category: '', description: 'd', amount: 10 },
            { type: 'EXPENSE', category: 'c', description: '', amount: 10 },
        ]) {
            const res = await postEntry(bad);
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        }
        expect(await db.businessLedgerEntry.count()).toBe(0);
    });

    test('9. settlement-sourced rows are append-only too (no hard delete for any source)', async () => {
        // A settlement-style row (as POS/payroll writers create them).
        const settlement = await db.businessLedgerEntry.create({
            data: {
                businessProfileId: A.biz.id,
                type: 'INCOME',
                category: 'SALES',
                description: 'POS Sale (ref-1 - CASH)',
                amount: 55,
                sourceType: 'POS_SALE',
                sourceId: 'order-1',
                metadata: {},
            },
        });
        const res = await deleteEntry(settlement.id);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // Original settlement row still exists; negating twin references it.
        const still = await db.businessLedgerEntry.findUnique({ where: { id: settlement.id } });
        expect(still).toBeTruthy();
        expect(Number(still.amount)).toBeCloseTo(55, 6);
        const twin = await db.businessLedgerEntry.findFirst({ where: { metadata: { path: ['reversalOf'], equals: settlement.id } } });
        expect(twin).toBeTruthy();
        expect(twin.sourceType).toBe('POS_SALE');
        expect(Number(twin.amount)).toBeCloseTo(-55, 6);
        // And a second DELETE of the same row is refused (409), zero mutation.
        const again = await deleteEntry(settlement.id);
        expect(again.status).toBe(409);
        expect(await db.businessLedgerEntry.count({ where: { businessProfileId: A.biz.id } })).toBe(2);
    });

    test('10. amount precision survives the pipeline', async () => {
        const amounts = [0.1, 0.2, 1234.56, 0.000001];
        for (const a of amounts) {
            const res = await postEntry({ type: 'INCOME', category: 'Sales', description: `precise ${a}`, amount: a });
            expect(res.status).toBe(201);
            expect(Number(res.body.entry.amount)).toBeCloseTo(a, 6);
        }
        const rows = await db.businessLedgerEntry.findMany({ where: { businessProfileId: A.biz.id } });
        const sum = rows.reduce((s, r) => s + Number(r.amount), 0);
        expect(sum).toBeCloseTo(0.1 + 0.2 + 1234.56 + 0.000001, 6);
    });
});
