// __tests__/r35-pos-cash-close-atomic.test.js
// =============================================================================
// r35/P0 — ATOMIC DINE-IN CASH CLOSE (real PostgreSQL, real HTTP, real
// middleware chain).
//
// The legacy inline POST /pos/cash-close-tab could:
//   • replay ANY business's tab by idempotencyKey (unscoped lookup);
//   • close one tab twice under two concurrent requests (unguarded update,
//     double ledger rows);
//   • leave a PAID tab with NO financial record (ledger write outside the
//     transaction, failure swallowed);
//   • accept NaN/Infinity/negative tip/cash via parseFloat.
//
// The canonical DineInCashCloseService now proves, against real PostgreSQL:
//   1. normal cash close (server-derived totals, preset tax, atomic ledger);
//   2. same-key retry replays the exact durable result;
//   3. same key + different request fails closed;
//   4. two concurrent identical closes — exactly one economic effect;
//   5. two concurrent different keys on one OPEN tab — exactly one close;
//   6. injected ledger failure — nothing committed, retry heals;
//   7. injected post-claim failure — complete rollback;
//   8. foreign-business tab/key cannot affect anything;
//   9. replay after the original response is lost returns the committed
//      result;
//  10. malformed money inputs fail closed.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R35_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r35/P0 — atomic dine-in cash close', () => {
    let db;
    let A, B;
    let seq = 0;

    const buildApp = (client) => {
        const a = express();
        a.use(express.json());
        a.set('prisma', client);
        a.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        a.use('/api/business-os', businessOSRoutes);
        return a;
    };

    const asUser = (user) => { global.__R35_USER__ = user ? { id: user.id } : null; };

    const closeTab = (app, payload) => request(app).post('/api/business-os/pos/cash-close-tab').send(payload);

    // A tab with two durable items: 100.0 + 20.0×2 = 140.0 subtotal.
    const seedOpenTab = async (biz, customer, items = [{ name: 'Jollof', price: 100, qty: 1 }, { name: 'Soda', price: 20, qty: 2 }]) => {
        const tab = await db.dineInTab.create({
            data: { businessProfileId: biz.id, customerId: customer.id, status: 'OPEN' },
        });
        for (const item of items) {
            await db.dineInTabItem.create({
                data: {
                    dineInTabId: tab.id,
                    name: item.name,
                    unitPriceUsdc: item.price,
                    quantity: item.qty,
                    lineTotalUsdc: item.price * item.qty,
                    addedBy: customer.id,
                },
            });
        }
        return tab;
    };

    const ledgerRows = (tabId) => db.businessLedgerEntry.findMany({
        where: tabId ? { sourceType: 'DINE_IN_CASH', sourceId: tabId } : { sourceType: 'DINE_IN_CASH' },
    });

    const body = (tabId, extra = {}) => ({
        tabId,
        cashReceived: 200,
        tipAmount: 1,
        idempotencyKey: `r35-key-${++seq}`,
        ...extra,
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });

    afterEach(async () => {
        global.__R35_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "DineInTabItem", "DineInTab", "BusinessLedgerEntry", "BusinessTaxPreset", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        asUser(A.owner);
        // Authoritative 2.5% default tax preset for business A.
        await db.businessTaxPreset.create({
            data: { businessProfileId: A.biz.id, name: 'VAT', type: 'PERCENTAGE', value: 2.5, isDefault: true },
        });
    });

    test('1. normal cash close: server-derived totals, preset tax, atomic ledger', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const app = buildApp(db);
        const res = await closeTab(app, body(tab.id));
        expect(res.status).toBe(200);
        const { tab: rt, subtotal, taxTotal, grandTotal, change } = res.body;
        expect(rt.id).toBe(tab.id);
        expect(rt.status).toBe('PAID');
        expect(rt.paymentMethod).toBe('CASH');
        expect(Number(subtotal)).toBe(140);               // 100 + 20×2
        expect(Number(taxTotal)).toBeCloseTo(3.5, 6);     // 2.5% preset — NOT the legacy hardcoded 5%
        expect(Number(grandTotal)).toBeCloseTo(144.5, 6); // + 1 tip
        expect(Number(rt.grandTotalUsdc)).toBeCloseTo(144.5, 6);
        expect(Number(change)).toBeCloseTo(200 - 144.5, 6);
        const ledger = await ledgerRows(tab.id);
        expect(ledger).toHaveLength(1);
        expect(Number(ledger[0].amount)).toBeCloseTo(144.5, 6);
        expect(ledger[0].type).toBe('INCOME');
        expect(ledger[0].sourceType).toBe('DINE_IN_CASH');
        expect(ledger[0].businessProfileId).toBe(A.biz.id);
    });

    test('2. same-key retry replays the exact durable result', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const app = buildApp(db);
        const key = `r35-replay-${++seq}`;
        const first = await closeTab(app, body(tab.id, { idempotencyKey: key }));
        expect(first.status).toBe(200);
        expect(first.body.message).toBeUndefined();
        const second = await closeTab(app, body(tab.id, { idempotencyKey: key }));
        expect(second.status).toBe(200);
        expect(second.body.message).toBe('Duplicate (idempotent)');
        expect(second.body.tab.id).toBe(first.body.tab.id);
        expect(Number(second.body.grandTotal)).toBeCloseTo(Number(first.body.grandTotal), 6);
        expect(Number(second.body.change)).toBeCloseTo(Number(first.body.change), 6);
        const ledger = await ledgerRows(tab.id);
        expect(ledger).toHaveLength(1);
    });

    test('3. same key + different request fails closed', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const app = buildApp(db);
        const key = `r35-conflict-${++seq}`;
        const first = await closeTab(app, body(tab.id, { idempotencyKey: key }));
        expect(first.status).toBe(200);
        // Same key, materially different request (tip 1 -> 2).
        const second = await closeTab(app, body(tab.id, { idempotencyKey: key, tipAmount: 2 }));
        expect(second.status).toBe(409);
        expect(second.body.success).toBe(false);
        expect(second.body.message).toMatch(/different cash close/i);
        // The committed result is untouched.
        const ledger = await ledgerRows(tab.id);
        expect(ledger).toHaveLength(1);
        expect(Number(ledger[0].amount)).toBeCloseTo(144.5, 6);
    });

    test('4. two concurrent identical closes — exactly one economic effect', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const app = buildApp(db);
        const key = `r35-race-same-${++seq}`;
        const payload = body(tab.id, { idempotencyKey: key });
        const [r1, r2] = await Promise.all([closeTab(app, payload), closeTab(app, { ...payload })]);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        const duplicates = [Boolean(r1.body.message), Boolean(r2.body.message)];
        // One original + one replay — never two originals.
        expect(duplicates.filter(Boolean)).toHaveLength(1);
        expect(r1.body.tab.id).toBe(tab.id);
        expect(r2.body.tab.id).toBe(tab.id);
        const ledger = await ledgerRows(tab.id);
        expect(ledger).toHaveLength(1);
        const finalTab = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(finalTab.status).toBe('PAID');
    });

    test('5. two concurrent different keys on one OPEN tab — exactly one close', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const app = buildApp(db);
        const [r1, r2] = await Promise.all([
            closeTab(app, body(tab.id, { idempotencyKey: `r35-race-a-${seq}` })),
            closeTab(app, body(tab.id, { idempotencyKey: `r35-race-b-${seq}` })),
        ]);
        seq += 1;
        const byStatus = [r1, r2].sort((a, b) => a.status - b.status);
        // Exactly one winner (lowest status = 200); the loser must be an
        // honest conflict (409), never a second economic close.
        expect(byStatus[0].status).toBe(200);
        expect(byStatus[0].body.message).toBeUndefined();
        expect(byStatus[1].status).toBe(409);
        expect(byStatus[1].body.success).toBe(false);
        expect(byStatus[1].body.message).toMatch(/closed by another request|not OPEN|another/i);
        const ledger = await ledgerRows(tab.id);
        expect(ledger).toHaveLength(1);
        const finalTab = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(finalTab.status).toBe('PAID');
    });

    test('6. injected ledger failure — nothing committed, retry heals', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        let failLedger = true;
        const xdb = db.$extends({
            query: {
                businessLedgerEntry: {
                    async create({ args, query }) {
                        if (failLedger) throw new Error('injected: ledger unavailable');
                        return query(args);
                    },
                },
            },
        });
        const res = await closeTab(buildApp(xdb), body(tab.id));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).not.toMatch(/swallow/i);
        // Complete rollback: the tab is STILL OPEN and unclaimed.
        const finalTab = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(finalTab.status).toBe('OPEN');
        expect(finalTab.idempotencyKey).toBeNull();
        expect(Number(finalTab.grandTotalUsdc)).toBe(0);
        expect(await ledgerRows(tab.id)).toHaveLength(0);
        // A retry after the failure heals — closes exactly once.
        const retry = await closeTab(buildApp(db), body(tab.id, { idempotencyKey: `r35-heal-${++seq}` }));
        expect(retry.status).toBe(200);
        expect(await ledgerRows(tab.id)).toHaveLength(1);
    });

    test('7. injected post-claim failure — complete rollback', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        // Fail the SECOND dineInTab.findUnique — the post-claim re-read that
        // happens AFTER the CAS claim and the ledger write.
        let occurrences = 0;
        const xdb = db.$extends({
            query: {
                dineInTab: {
                    async findUnique({ args, query }) {
                        occurrences += 1;
                        if (occurrences === 2) throw new Error('injected: post-claim crash');
                        return query(args);
                    },
                },
            },
        });
        const res = await closeTab(buildApp(xdb), body(tab.id));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(occurrences).toBeGreaterThanOrEqual(2); // the failure was genuinely post-claim
        // Post-claim crash rolled the ENTIRE settlement back.
        const finalTab = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(finalTab.status).toBe('OPEN');
        expect(finalTab.idempotencyKey).toBeNull();
        expect(await ledgerRows(tab.id)).toHaveLength(0);
    });

    test('8. foreign-business tab and key cannot affect anything', async () => {
        const tabA = await seedOpenTab(A.biz, A.owner);
        const key = `r35-foreign-${++seq}`;
        // Business A closes its tab normally.
        expect((await closeTab(buildApp(db), body(tabA.id, { idempotencyKey: key }))).status).toBe(200);
        // Business B replays A's key against A's tab — refusal, not replay.
        asUser(B.owner);
        const keyTheft = await closeTab(buildApp(db), body(tabA.id, { idempotencyKey: key }));
        expect(keyTheft.status).toBe(409);
        expect(keyTheft.body.message).toMatch(/another business/i);
        // Business B tries its OWN fresh key against A's tab: 404, no effect.
        const crossTab = await closeTab(buildApp(db), body(tabA.id, { idempotencyKey: `r35-b-own-${++seq}` }));
        expect(crossTab.status).toBe(404);
        expect(crossTab.body.message).toMatch(/not found/i);
        // Nothing was mutated anywhere.
        expect(await ledgerRows()).toHaveLength(1);
        const finalA = await db.dineInTab.findUnique({ where: { id: tabA.id } });
        expect(finalA.status).toBe('PAID');
        expect(finalA.businessProfileId).toBe(A.biz.id);
    });

    test('8b. a foreign key never replays another business\'s tab payload', async () => {
        const tabA = await seedOpenTab(A.biz, A.owner);
        const key = `r35-noleak-${++seq}`;
        expect((await closeTab(buildApp(db), body(tabA.id, { idempotencyKey: key }))).status).toBe(200);
        asUser(B.owner);
        // B replays A's key but supplies B's OWN tab — still a refusal,
        // and B's tab is untouched.
        const tabB = await seedOpenTab(B.biz, B.owner);
        const res = await closeTab(buildApp(db), body(tabB.id, { idempotencyKey: key }));
        expect(res.status).toBe(409);
        const finalB = await db.dineInTab.findUnique({ where: { id: tabB.id } });
        expect(finalB.status).toBe('OPEN');
        expect(await ledgerRows(tabB.id)).toHaveLength(0);
    });

    test('9. replay after a lost response returns the committed result', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const key = `r35-lost-${++seq}`;
        const first = await closeTab(buildApp(db), body(tab.id, { idempotencyKey: key }));
        expect(first.status).toBe(200);
        // Original response "lost": client retries with the same key.
        const replay = await closeTab(buildApp(db), body(tab.id, { idempotencyKey: key }));
        expect(replay.status).toBe(200);
        expect(replay.body.tab.id).toBe(first.body.tab.id);
        expect(Number(replay.body.grandTotal)).toBeCloseTo(Number(first.body.grandTotal), 6);
        expect(Number(replay.body.change)).toBeCloseTo(Number(first.body.change), 6);
        expect(await ledgerRows(tab.id)).toHaveLength(1);
    });

    test('10. malformed money inputs fail closed', async () => {
        const tab = await seedOpenTab(A.biz, A.owner);
        const app = buildApp(db);
        for (const bad of [
            { tipAmount: 'abc' }, { tipAmount: 'NaN' }, { tipAmount: -1 },
            { cashReceived: 'Infinity' }, { cashReceived: 'abc' }, { cashReceived: -5 },
        ]) {
            const res = await closeTab(app, body(tab.id, bad));
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        }
        // Insufficient cash is refused too.
        const short = await closeTab(app, body(tab.id, { cashReceived: 1 }));
        expect(short.status).toBe(400);
        expect(short.body.message).toMatch(/insufficient cash/i);
        // The tab survived every malformed attempt.
        const finalTab = await db.dineInTab.findUnique({ where: { id: tab.id } });
        expect(finalTab.status).toBe('OPEN');
        expect(await ledgerRows(tab.id)).toHaveLength(0);
    });
});
