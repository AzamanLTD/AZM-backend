// __tests__/r37-dinein-strict-money.test.js
// =============================================================================
// r37/P1 — DINE-IN CASH CLOSE: STRICT EXACT-DECIMAL MONEY (real PostgreSQL).
//
// The legacy dine-in parser was blind parseFloat: it accepted exponent
// notation, padded whitespace, and silently ROUNDED values beyond 6 decimals
// against Decimal(20,8) storage — the exact float-vs-Decimal precision loss
// that could not corrupt a ledger but could misrepresent cash. The parser now
// runs on the platform's ONE canonical exact-decimal authority
// (ledger.toExactDecimal) and returns Prisma.Decimal end-to-end:
//   • exponent notation / padding / >8dp / NaN / Inf / negative → 400, closed
//   • valid 8dp values survive parse → arithmetic → storage EXACTLY
//   • the ledger row and metadata carry the exact 8-decimal forms
//   • replay returns the durable committed result (idempotency contract held)
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { DineInCashCloseService } = require('../services/businessOS/dineInCashCloseService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r37/P1 — dine-in cash close strict money', () => {
    let db;
    let svc;
    let biz;
    let owner;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        svc = new DineInCashCloseService(db);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe('TRUNCATE TABLE "DineInTabItem", "DineInTab", "BusinessTable", "BusinessLocation", "BusinessLedgerEntry", "BusinessTaxPreset", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        const seeded = await seedBusiness(db);
        biz = seeded.biz;
        owner = seeded.owner;
    });

    async function mkTab(lines) {
        const loc = await db.businessLocation.create({
            data: { businessProfileId: biz.id, label: 'Hall', address: 'Accra', latitude: 5.6, longitude: -0.2 },
        });
        const table = await db.businessTable.create({ data: { locationId: loc.id, label: 'T1' } });
        const guest = await db.user.create({
            data: { username: `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, email: `g-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@t.azm`, password: 'x', role: 'USER' },
        });
        const tab = await db.dineInTab.create({
            data: { businessProfileId: biz.id, locationId: loc.id, tableId: table.id, customerId: guest.id, status: 'OPEN' },
        });
        for (const [name, unitPrice, qty] of lines) {
            await db.dineInTabItem.create({
                data: { dineInTabId: tab.id, name, unitPriceUsdc: unitPrice, quantity: qty, lineTotalUsdc: unitPrice * qty, addedBy: owner.id },
            });
        }
        return tab;
    }

    const close = (tabId, body) =>
        svc.closeTab({ businessProfileId: biz.id, actorId: owner.id, tabId, ...body });

    // ── Strict parser contract ────────────────────────────────────────────────

    test.each([
        ['exponent notation', '1e3', 'tipAmount'],
        ['exponent lowercase', '10.5e2', 'tipAmount'],
        ['leading whitespace', ' 5', 'tipAmount'],
        ['trailing whitespace', '5 ', 'tipAmount'],
        ['inner whitespace', '1 5', 'tipAmount'],
        ['nine decimals (silent rounding before)', '0.123456789', 'tipAmount'],
        ['NaN', 'NaN', 'tipAmount'],
        ['Infinity', 'Infinity', 'tipAmount'],
        ['negative tip', '-5', 'tipAmount'],
        ['negative cash', '-100', 'cashReceived'],
        ['oversized', '2000000000', 'tipAmount'],
        ['hex', '0x10', 'tipAmount'],
    ])('rejects %s → INVALID_INPUT, tab stays OPEN', async (_label, value, field) => {
        const tab = await mkTab([['Jollof', 25, 2]]);
        await expect(close(tab.id, { [field]: value, idempotencyKey: `bad-${field}-${Math.random()}` }))
            .rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const after = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(after.status).toBe('OPEN');
        expect(await db.businessLedgerEntry.count({ where: { sourceType: 'DINE_IN_CASH' } })).toBe(0);
    });

    test('empty string tip = 0 (no crash), null cash = no cash field', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]);
        const res = await close(tab.id, { tipAmount: '', idempotencyKey: 'zero-tip' });
        expect(res.duplicate).toBe(false);
        expect(res.tip).toBe(0);
        expect(res.tab.status).toBe('PAID');
        expect(res.tab.cashReceived).toBe(null);
    });

    // ── Exactness end-to-end ────────────────────────────────────────────────

    test('8-decimal tip/cash survive parse → arithmetic → storage EXACTLY', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]); // subtotal 50, no tax preset → tax 0
        const res = await close(tab.id, {
            tipAmount: '0.12345678',
            cashReceived: '100.12345678',
            idempotencyKey: 'exact-8dp',
        });
        expect(res.duplicate).toBe(false);
        expect(res.grandTotal).toBe(50.12345678);
        expect(res.change).toBeCloseTo(50, 6);

        const stored = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(stored.tipUsdc.toString()).toBe('0.12345678');
        expect(stored.cashReceived.toString()).toBe('100.12345678');
        expect(stored.grandTotalUsdc.toString()).toBe('50.12345678');

        const ledgerRow = await db.businessLedgerEntry.findFirst({ where: { sourceType: 'DINE_IN_CASH', sourceId: tab.id } });
        expect(ledgerRow.amount.toString()).toBe('50.12345678');
        expect(ledgerRow.metadata.tip).toBe('0.12345678');
        expect(ledgerRow.metadata.cashReceived).toBe('100.12345678');
        expect(ledgerRow.metadata.cashChange).toBe('50.00000000');
    });

    test('insufficient cash fails closed with exact 8dp comparison', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]);
        // Grand total is exactly 50. Cash one hundred-millionth short is
        // honestly below under exact decimals — and stays a legal 8dp value.
        await expect(close(tab.id, { cashReceived: '49.99999999', idempotencyKey: 'short-cash' }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_CASH' });
        expect((await db.dineInTab.findUnique({ where: { id: tab.id } })).status).toBe('OPEN');
        // And exact payment passes with zero change.
        const res = await close(tab.id, { cashReceived: '50', idempotencyKey: 'exact-cash' });
        expect(res.change).toBe(0);
    });

    test('numeric (non-string) money inputs still accepted exactly', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]);
        const res = await close(tab.id, { tipAmount: 2.5, cashReceived: 60, idempotencyKey: 'numeric-input' });
        expect(res.grandTotal).toBe(52.5);
        expect(res.change).toBeCloseTo(7.5, 6);
    });

    // ── Idempotent replay under the strict parser ────────────────────────────

    test('replay returns the durable committed result with exact values', async () => {
        const tab = await mkTab([['Jollof', 25, 2], ['Water', 1.25, 2]]); // 52.5
        const first = await close(tab.id, { tipAmount: '0.12345678', cashReceived: '60', idempotencyKey: 'replay-key' });
        expect(first.duplicate).toBe(false);
        const replay = await close(tab.id, { tipAmount: '0.12345678', cashReceived: '60', idempotencyKey: 'replay-key' });
        expect(replay.duplicate).toBe(true);
        expect(replay.tip).toBeCloseTo(0.12345678, 8);
        expect(replay.grandTotal).toBeCloseTo(52.62345678, 8);
        expect(await db.businessLedgerEntry.count({ where: { sourceType: 'DINE_IN_CASH' } })).toBe(1);
    });

    test('same key, different economics → conflict (fingerprint over exact forms)', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]);
        await close(tab.id, { tipAmount: '1', cashReceived: '60', idempotencyKey: 'fp-key' });
        await expect(close(tab.id, { tipAmount: '2', cashReceived: '60', idempotencyKey: 'fp-key' }))
            .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });
});
