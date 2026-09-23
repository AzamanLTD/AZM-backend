// __tests__/r36-dinein-tab-race.test.js
// =============================================================================
// r36/P1 — DINE-IN TABLE STATUS RACE (real PostgreSQL, real HTTP).
//
// The legacy PATCH /restaurant/tables/:id/status did an untransacted
// read-modify-write: two concurrent PATCHes both observed "no active tab"
// and created TWO tabs on one table; a racing close interleaved with an
// update. r36 makes ONE authoritative transaction per change:
//   • every status change is serialized by a row lock on BusinessTable;
//   • the active-tab lookup happens INSIDE the transaction;
//   • the partial unique index (one non-CLOSED tab per table) is the
//     database backstop — the losing creator converges on the winner's tab;
//   • 'OPEN' closes any active tab exactly once, idempotently.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_DI_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_DI_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36/P1 — dine-in table status race', () => {
    let db;
    let app;
    let A, B;
    let guest;
    let tableA, tableB;

    const asUser = (user) => { global.__R36_DI_USER__ = user ? { id: user.id } : null; };
    const setStatus = (tableId, status) => request(app)
        .patch(`/api/business-os/restaurant/tables/${tableId}/status`).send({ status });
    const activeTabs = (tableId) => db.dineInTab.count({
        where: { tableId, status: { not: 'CLOSED' } },
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.use('/api/business-os', businessOSRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R36_DI_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "DineInTabItem", "DineInTab", "BusinessTable", "BusinessLocation", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        asUser(A.owner);

        guest = await db.user.findUnique({ where: { email: 'guest-walkin@azaman.azm' } });
        if (!guest) {
            guest = await db.user.create({
                data: { username: 'guest-walkin', email: 'guest-walkin@azaman.azm', password: 'x', role: 'USER' },
            });
        }

        const locA = await db.businessLocation.create({
            data: { businessProfileId: A.biz.id, label: 'Main Hall', address: 'Accra', latitude: 5.6, longitude: -0.2 },
        });
        const locB = await db.businessLocation.create({
            data: { businessProfileId: B.biz.id, label: 'Other Hall', address: 'Kumasi', latitude: 6.7, longitude: -1.6 },
        });
        tableA = await db.businessTable.create({ data: { locationId: locA.id, label: 'T1' } });
        tableB = await db.businessTable.create({ data: { locationId: locB.id, label: 'T2' } });
    });

    test('first status change creates exactly ONE tab; invalid status rejected', async () => {
        expect((await setStatus(tableA.id, 'NOT_A_STATUS')).status).toBe(400);
        const res = await setStatus(tableA.id, 'SEATED');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SEATED');
        expect(await activeTabs(tableA.id)).toBe(1);
        const tab = await db.dineInTab.findFirst({ where: { tableId: tableA.id } });
        expect(tab.status).toBe('SEATED');
        expect(tab.customerId).toBe(guest.id);
    });

    test('subsequent statuses UPDATE the existing tab, never a second one', async () => {
        await setStatus(tableA.id, 'SEATED');
        await setStatus(tableA.id, 'ORDERED');
        await setStatus(tableA.id, 'EATING');
        expect(await activeTabs(tableA.id)).toBe(1);
        const tabs = await db.dineInTab.findMany({ where: { tableId: tableA.id } });
        expect(tabs.length).toBe(1);
        expect(tabs[0].status).toBe('EATING');
    });

    test('CONCURRENT PATCHes converge: exactly one tab is created, all succeed', async () => {
        const results = await Promise.all([
            setStatus(tableA.id, 'SEATED'), setStatus(tableA.id, 'SEATED'),
            setStatus(tableA.id, 'SEATED'), setStatus(tableA.id, 'SEATED'),
        ]);
        for (const r of results) expect(r.status).toBe(200);
        const tabs = await db.dineInTab.findMany({ where: { tableId: tableA.id } });
        expect(tabs.length).toBe(1);
        expect(tabs[0].status).toBe('SEATED');
    });

    test('going back to OPEN closes the tab exactly once; repeat is a no-op', async () => {
        await setStatus(tableA.id, 'SEATED');
        expect(await activeTabs(tableA.id)).toBe(1);

        expect((await setStatus(tableA.id, 'OPEN')).status).toBe(200);
        expect(await activeTabs(tableA.id)).toBe(0);

        // Repeat OPEN: idempotent.
        expect((await setStatus(tableA.id, 'OPEN')).status).toBe(200);
        expect(await activeTabs(tableA.id)).toBe(0);
        const closed = await db.dineInTab.findMany({ where: { tableId: tableA.id, status: 'CLOSED' } });
        expect(closed.length).toBe(1);

        // After closing, a new status opens a NEW tab.
        await setStatus(tableA.id, 'SEATED');
        expect(await activeTabs(tableA.id)).toBe(1);
        expect((await db.dineInTab.findMany({ where: { tableId: tableA.id } })).length).toBe(2);
    });

    test('close racing with an update: no impossible terminal state, at most one active tab', async () => {
        await setStatus(tableA.id, 'SEATED');
        const results = await Promise.all([
            setStatus(tableA.id, 'OPEN'),   // closes the tab
            setStatus(tableA.id, 'EATING'), // updates it
        ]);
        // Both succeed; the row lock serializes them. The final state is
        // whatever won LAST in commit order — but it is always consistent:
        // either one active tab with the last-written status, or none.
        for (const r of results) expect(r.status).toBe(200);
        const active = await activeTabs(tableA.id);
        expect(active).toBeLessThanOrEqual(1);
        if (active === 1) {
            const tab = await db.dineInTab.findFirst({ where: { tableId: tableA.id, status: { not: 'CLOSED' } } });
            expect(['SEATED', 'EATING']).toContain(tab.status);
        }
    });

    test('foreign business table → 404', async () => {
        expect((await setStatus(tableB.id, 'SEATED')).status).toBe(404);
        expect(await db.dineInTab.count()).toBe(0);
    });
});
