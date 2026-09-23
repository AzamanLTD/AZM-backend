// __tests__/r32-dinein-tab-tenant-boundary.test.js
// =============================================================================
// r32 audit item F — DINE-IN TAB MUTATION TENANT BOUNDARY (real PostgreSQL,
// real HTTP routes, real requirePermission chain).
//
// Historical defects:
//   • the controller derived the effective business from the pre-r32 dead
//     property `req.adminScopedBusiness` (never set by the scope middleware),
//     so ADMIN impersonation silently degraded to the owner lookup and 403'd;
//   • the business-side tab mutations (addItem, finalizeTab, reportDefault)
//     proved the CALLER was staff of their OWN business, but never proved the
//     TAB belonged to that business — a staff member of business B could
//     mutate, finalize, or cancel a tab of business A by id.
//
// Fixed contract:
//   • scope resolution goes through the ONE canonical resolveBusinessContext
//     (honoring the validated req.adminBusinessScope);
//   • every business-side tab mutation carries the effective business id into
//     the service, which asserts it against the locked tab row INSIDE the
//     transaction (no TOCTOU window);
//   • a foreign tab id is answered "Tab not found." — indistinguishable from
//     an unknown id, no state leak.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R32_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/kybGateMiddleware', () => ({
    kybGate: (_req, _res, next) => next(), // environmental precondition, not the boundary under test
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient } = require('@prisma/client');
const dineInRoutes = require('../routes/dineInRoutes');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r32 F — dine-in tab tenant boundary (real routes, real PostgreSQL)', () => {
    let db;
    let app;
    let A, B;
    let customer;
    let tabA; // an OPEN tab belonging to business A
    let seq = 0;

    const buildApp = () => {
        const a = express();
        a.use(express.json());
        a.set('prisma', db);
        a.set('logger', { error: () => {} });
        // Simulates the validated admin scope header path (the scope
        // middleware's post-validation state), settable per test. The scope is
        // exposed lazily: protect attaches req.user AFTER app-level middleware
        // runs, so the getter resolves at requirePermission read time.
        a.use((req, _res, next) => {
            Object.defineProperty(req, 'adminBusinessScope', {
                configurable: true,
                get() {
                    return (req.user?.role === 'ADMIN' && global.__R32_ADMIN_SCOPE__)
                        ? { businessProfileId: global.__R32_ADMIN_SCOPE__ }
                        : undefined;
                },
            });
            next();
        });
        a.use('/api/dine-in', dineInRoutes);
        return a;
    };

    const asUser = (user) => { global.__R32_USER__ = user ? { id: user.id, role: user.role } : null; };

    const openTabFor = async (biz) => {
        const res = await request(app)
            .post('/api/dine-in/tabs')
            .send({ customerAzamanId: customer.azamanId });
        return res;
    };

    const addItem = (tabId, body = {}) => request(app)
        .post(`/api/dine-in/tabs/${tabId}/items`)
        .send({ productId: A.product.id, quantity: 1, ...body });
    const finalize = (tabId) => request(app).post(`/api/dine-in/tabs/${tabId}/finalize`);
    const reportDefault = (tabId) => request(app).post(`/api/dine-in/tabs/${tabId}/default`).send({ reason: 'walked out' });
    const openTabs = () => request(app).get('/api/dine-in/tabs');

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = buildApp();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R32_USER__ = null;
        global.__R32_ADMIN_SCOPE__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "DineInTabItem", "DineInTab", "BusinessInvoice", "BusinessTable", "BusinessLocation", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        customer = await db.user.create({
            data: {
                username: `r32_diner_${++seq}`,
                email: `r32_diner_${seq}@test.com`,
                password: 'x',
                azamanId: `AZM-${String(1000000 + seq).padStart(9, '0')}`,
                availableBalance: 500,
            },
        });
        asUser(A.owner);
        const open = await openTabFor(A.biz);
        tabA = open.body.tab || open.body;
        // The pre-r32 controller returned { ...result } shapes; find the id.
        tabA = { id: (open.body.tab?.id || open.body.id || open.body.data?.id) };
        expect(open.status).toBe(201);
    });

    test('1. same-business staff can add items and finalize (atomic happy path)', async () => {
        asUser(A.owner);
        const add = await addItem(tabA.id);
        expect(add.status).toBe(200);

        const row = await db.dineInTabItem.findFirst({ where: { dineInTabId: tabA.id } });
        expect(row).toBeTruthy();
        expect(Number(row.unitPriceUsdc)).toBe(Number(A.product.priceUsdc));

        const fin = await finalize(tabA.id);
        expect(fin.status).toBe(200);
        const tab = await db.dineInTab.findUnique({ where: { id: tabA.id } });
        expect(tab.status).toBe('FINALIZED');
        expect(Number(tab.grandTotalUsdc)).toBe(Number(A.product.priceUsdc) * 1);
    });

    test('2. a foreign business cannot add items to another business\'s tab', async () => {
        asUser(B.owner);
        const add = await addItem(tabA.id, { productId: B.product.id });
        expect(add.status).toBe(400);
        expect(add.body.message).toBe('Tab not found.');

        // No items were injected into A's tab.
        const items = await db.dineInTabItem.findMany({ where: { dineInTabId: tabA.id } });
        expect(items).toHaveLength(0);
    });

    test('3. a foreign business cannot finalize another business\'s tab', async () => {
        asUser(B.owner);
        const fin = await finalize(tabA.id);
        expect(fin.status).toBe(400);
        expect(fin.body.message).toBe('Tab not found.');

        const tab = await db.dineInTab.findUnique({ where: { id: tabA.id } });
        expect(tab.status).toBe('OPEN'); // untouched, still OPEN for A
    });

    test('4. a foreign business cannot default-report (cancel) another business\'s tab', async () => {
        asUser(B.owner);
        const rep = await reportDefault(tabA.id);
        expect(rep.status).toBe(400);
        expect(rep.body.message).toBe('Tab not found.');

        const tab = await db.dineInTab.findUnique({ where: { id: tabA.id } });
        expect(tab.status).toBe('OPEN'); // survived the foreign cancellation
    });

    test('5. the tab remains fully usable by its own business after the foreign attempts', async () => {
        asUser(B.owner);
        await addItem(tabA.id);
        await finalize(tabA.id);
        await reportDefault(tabA.id);

        asUser(A.owner);
        const add = await addItem(tabA.id);
        expect(add.status).toBe(200);
        const fin = await finalize(tabA.id);
        expect(fin.status).toBe(200);
        const tab = await db.dineInTab.findUnique({ where: { id: tabA.id } });
        expect(tab.status).toBe('FINALIZED');
    });

    test('6. ADMIN impersonation reaches the business dine-in surface through the canonical scope (dead-property regression)', async () => {
        const admin = await db.user.create({
            data: {
                username: `r32_admin_${++seq}`,
                email: `r32_admin_${seq}@test.com`,
                password: 'x',
                azamanId: `AZM-${String(2000000 + seq).padStart(9, '0')}`,
                role: 'ADMIN',
                availableBalance: 0,
            },
        });

        // Pre-r32: req.adminScopedBusiness was never set, so the admin fell
        // through to the owned-business lookup (admins own none) → 403.
        asUser(admin);
        global.__R32_ADMIN_SCOPE__ = A.biz.id;

        const list = await openTabs();
        expect(list.status).toBe(200);
        expect(list.body.tabs).toHaveLength(1);
        expect(list.body.tabs[0].id).toBe(tabA.id);
    });
});
