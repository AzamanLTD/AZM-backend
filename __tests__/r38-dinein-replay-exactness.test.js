// __tests__/r38-dinein-replay-exactness.test.js
// =============================================================================
// r38/P1 — DINE-IN REPLAY EXACTNESS (real PostgreSQL).
//
// The r37 idempotent replay of a cash close recomputed `change` with JS
// float math rounded to 6dp (Math.round((cash-grand)*1e6)/1e6): a committed
// change of 0.00000001 replayed as 0. The committed path already ran on
// Prisma.Decimal (Decimal(20,8) authority end-to-end) — the replay must
// reproduce the committed economic result BIT-FOR-BIT.
//
// Proofs:
//   • an 8dp change (0.00000001) commits exactly AND replays exactly —
//     original response and idempotent replay agree on every field;
//   • the 6dp rounding path is dead: no change value is quantized;
//   • a different key against the PAID tab still fails TAB_ALREADY_CLOSED.
// =============================================================================
const { PrismaClient, Prisma } = require('@prisma/client');
const { DineInCashCloseService } = require('../services/businessOS/dineInCashCloseService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r38/P1 — dine-in replay exactness', () => {
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

    test('8dp change commits exactly and replays BIT-FOR-BIT (no 6dp quantization)', async () => {
        const tab = await mkTab([['Pin', '0.00000001', 1]]); // subtotal 1e-8, no tax preset
        const first = await close(tab.id, { cashReceived: '0.00000002', idempotencyKey: 'exact-replay-1' });

        // Committed path: exact decimal change of 1e-8.
        expect(first.duplicate).toBe(false);
        expect(first.grandTotal).toBe(1e-8);
        expect(first.change).toBe(1e-8); // NOT Math.round(1e-8*1e6)/1e6 === 0

        // Durable row agrees at full Decimal(20,8) precision.
        const row = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(new Prisma.Decimal(row.cashReceived).toFixed(8)).toBe('0.00000002');
        expect(new Prisma.Decimal(row.grandTotalUsdc).toFixed(8)).toBe('0.00000001');

        // Idempotent replay: every economic field identical to the original.
        const replay = await close(tab.id, { cashReceived: '0.00000002', idempotencyKey: 'exact-replay-1' });
        expect(replay.duplicate).toBe(true);
        expect(replay.subtotal).toBe(first.subtotal);
        expect(replay.taxTotal).toBe(first.taxTotal);
        expect(replay.tip).toBe(first.tip);
        expect(replay.grandTotal).toBe(first.grandTotal);
        expect(replay.change).toBe(first.change); // 1e-8, not 0
        expect(replay.change).toBe(1e-8);
    });

    test('mid-precision change (7dp) replays exactly', async () => {
        const tab = await mkTab([['Snack', '0.1234567', 1]]);
        const first = await close(tab.id, { cashReceived: '0.1234568', idempotencyKey: 'exact-replay-2' });
        expect(first.change).toBe(1e-7);
        const replay = await close(tab.id, { cashReceived: '0.1234568', idempotencyKey: 'exact-replay-2' });
        expect(replay.duplicate).toBe(true);
        expect(replay.change).toBe(first.change);
        expect(replay.change).toBe(1e-7);
    });

    test('ordinary 2dp close replays identically (regression: no behavior change)', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]); // subtotal 50
        const first = await close(tab.id, { cashReceived: '60', tipAmount: '5', idempotencyKey: 'exact-replay-3' });
        expect(first.subtotal).toBe(50);
        expect(first.grandTotal).toBe(55);
        expect(first.change).toBe(5);
        const replay = await close(tab.id, { cashReceived: '60', tipAmount: '5', idempotencyKey: 'exact-replay-3' });
        expect(replay.duplicate).toBe(true);
        expect(replay.change).toBe(5);
        expect(replay.grandTotal).toBe(55);
    });

    test('different key against the PAID tab still fails TAB_ALREADY_CLOSED', async () => {
        const tab = await mkTab([['Jollof', 25, 2]]);
        await close(tab.id, { cashReceived: '50', idempotencyKey: 'exact-replay-4' });
        await expect(close(tab.id, { cashReceived: '50', idempotencyKey: 'exact-replay-5' }))
            .rejects.toMatchObject({ code: 'TAB_ALREADY_CLOSED' });
    });
});
