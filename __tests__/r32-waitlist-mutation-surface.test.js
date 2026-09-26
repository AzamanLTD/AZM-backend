// __tests__/r32-waitlist-mutation-surface.test.js
// =============================================================================
// r32 audit item E — WAITLIST MUTATION SURFACE (real PostgreSQL, real routes).
//
// Historical defect surface: every waitlist route already carried the effective
// business id into the where-clause, BUT the mutation inputs were unvalidated:
// a foreign locationId could be attached on add, a foreign tableId could be
// attached on edit/seat, and arbitrary status strings were accepted.
//
// Fixed contract:
//   • add validates the referenced location belongs to the effective business;
//   • edit/seat validates the referenced table belongs to the effective business
//     and the status is a known waitlist status;
//   • all entry mutations resolve the entry by { id, businessProfileId };
//   • a foreign entry id is denied (404) without leaking its state, and after
//     removal every further mutation on that id is refused.
//
// The routes are exercised over real HTTP with the REAL requirePermission
// chain (only the identity-attach middleware is stubbed to the seeded user),
// so the whole owner → permission → context resolution path is live.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R32_USER__; next(); },
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

run('r32 E — waitlist mutation surface (real routes, real PostgreSQL)', () => {
    let db;
    let app;
    let A, B; // two businesses with owner users
    let seq = 0;

    const buildApp = () => {
        const a = express();
        a.use(express.json());
        a.set('prisma', db);
        a.set('logger', { error: () => {} });
        a.use('/api/business-os', businessOSRoutes);
        return a;
    };

    const asUser = (user) => { global.__R32_USER__ = user ? { id: user.id } : null; };

    const addEntry = (biz, body) => request(app)
        .post('/api/business-os/restaurant/waitlist')
        .send({ partyName: `Party ${++seq}`, ...body });
    const patchEntry = (id, body) => request(app)
        .patch(`/api/business-os/restaurant/waitlist/${id}`)
        .send(body);
    const deleteEntry = (id) => request(app).delete(`/api/business-os/restaurant/waitlist/${id}`);
    const listEntries = () => request(app).get('/api/business-os/restaurant/waitlist');

    const mkTable = async (biz) => {
        const location = await db.businessLocation.create({
            data: { businessProfileId: biz.id, label: `Branch ${++seq}`, address: 'Test Address', city: 'Accra', latitude: 5.6, longitude: -0.2 },
        });
        const table = await db.businessTable.create({
            data: { locationId: location.id, label: `Table ${++seq}` },
        });
        return { location, table };
    };

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = buildApp();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R32_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "RestaurantWaitlistEntry", "BusinessTable", "BusinessLocation", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
    });

    test('1. add/edit/seat/list the full mutation surface works inside one business', async () => {
        asUser(A.owner);
        const { table } = await mkTable(A.biz);

        const add = await addEntry(A.biz, { partyName: 'Okonkwo party', partySize: 4, quotedWaitMinutes: 15 });
        expect(add.status).toBe(201);
        const entryId = add.body.data.id;
        expect(add.body.data.businessProfileId).toBe(A.biz.id);

        const notified = await patchEntry(entryId, { status: 'NOTIFIED' });
        expect(notified.status).toBe(200);
        const seated = await patchEntry(entryId, { status: 'SEATED', tableId: table.id });
        expect(seated.status).toBe(200);

        const row = await db.restaurantWaitlistEntry.findUnique({ where: { id: entryId } });
        expect(row.status).toBe('SEATED');
        expect(row.tableId).toBe(table.id);
        expect(row.seatedAt).toBeTruthy();
        expect(row.notifiedAt).toBeTruthy();

        const list = await listEntries();
        expect(list.status).toBe(200);
    });

    test('2. a foreign entry id is denied on edit and seat — and survives untouched in its own business', async () => {
        asUser(B.owner);
        const foreignAdd = await addEntry(B.biz, { partyName: 'Foreign party' });
        const foreignId = foreignAdd.body.data.id;

        asUser(A.owner);
        const edit = await patchEntry(foreignId, { status: 'SEATED' });
        expect(edit.status).toBe(404);
        const seat = await patchEntry(foreignId, { status: 'SEATED' });
        expect(seat.status).toBe(404);

        // The foreign entry is untouched and still usable by its own owner.
        const row = await db.restaurantWaitlistEntry.findUnique({ where: { id: foreignId } });
        expect(row.status).toBe('WAITING');
        asUser(B.owner);
        const ownEdit = await patchEntry(foreignId, { status: 'NOTIFIED' });
        expect(ownEdit.status).toBe(200);
    });

    test('3. removal revokes every further mutation on that entry id', async () => {
        asUser(A.owner);
        const add = await addEntry(A.biz, { partyName: 'Temp party' });
        const id = add.body.data.id;

        const del = await deleteEntry(id);
        expect(del.status).toBe(200);
        expect(await db.restaurantWaitlistEntry.findUnique({ where: { id } })).toBeNull();

        // Every mutation surface on the removed entry is now refused.
        expect((await patchEntry(id, { status: 'NOTIFIED' })).status).toBe(404);
        expect((await patchEntry(id, { status: 'SEATED' })).status).toBe(404);
        // Re-removal converges without leaking existence.
        expect((await deleteEntry(id)).status).toBe(200);
    });

    test('4. a foreign entry cannot be removed from another business', async () => {
        asUser(B.owner);
        const foreignAdd = await addEntry(B.biz, { partyName: 'B party' });
        const foreignId = foreignAdd.body.data.id;

        asUser(A.owner);
        const del = await deleteEntry(foreignId);
        expect(del.status).toBe(200); // converged outcome, nothing removed
        const row = await db.restaurantWaitlistEntry.findUnique({ where: { id: foreignId } });
        expect(row).toBeTruthy(); // still alive in its own business
    });

    test('5. seating may only reference a table of the SAME business', async () => {
        asUser(A.owner);
        const add = await addEntry(A.biz, { partyName: 'A party' });
        const entryId = add.body.data.id;
        const BTable = (await mkTable(B.biz)).table;

        // A foreign table id is refused, and the entry keeps its state.
        const seatForeign = await patchEntry(entryId, { status: 'SEATED', tableId: BTable.id });
        expect(seatForeign.status).toBe(404);
        const mid = await db.restaurantWaitlistEntry.findUnique({ where: { id: entryId } });
        expect(mid.status).toBe('WAITING');
        expect(mid.tableId).toBeNull();

        // A same-business table is accepted.
        const ATable = (await mkTable(A.biz)).table;
        const seatOwn = await patchEntry(entryId, { status: 'SEATED', tableId: ATable.id });
        expect(seatOwn.status).toBe(200);
    });

    test('6. add may only reference a location of the SAME business', async () => {
        asUser(A.owner);
        const BLocation = (await mkTable(B.biz)).location;

        const addForeign = await addEntry(A.biz, { partyName: 'Sneaky party', locationId: BLocation.id });
        expect(addForeign.status).toBe(404);
        expect(await db.restaurantWaitlistEntry.count({ where: { partyName: 'Sneaky party' } })).toBe(0);

        const ALocation = (await mkTable(A.biz)).location;
        const addOwn = await addEntry(A.biz, { partyName: 'Honest party', locationId: ALocation.id });
        expect(addOwn.status).toBe(201);
        expect(addOwn.body.data.locationId).toBe(ALocation.id);
    });

    test('7. unknown waitlist statuses are refused; the entry keeps its state', async () => {
        asUser(A.owner);
        const add = await addEntry(A.biz, { partyName: 'Status party' });
        const entryId = add.body.data.id;

        const bad = await patchEntry(entryId, { status: 'HACKED' });
        expect(bad.status).toBe(400);
        const row = await db.restaurantWaitlistEntry.findUnique({ where: { id: entryId } });
        expect(row.status).toBe('WAITING');
    });

    test('8. an employee of another business resolves to NOTHING and is refused', async () => {
        // A user with no business relationship at all: requirePermission
        // resolves no context → every waitlist mutation is refused.
        const orphan = await db.user.create({
            data: { username: `r32_orphan_${++seq}`, email: `r32_orphan_${seq}@test.com`, password: 'x', azamanId: `AZM-ORPH-${seq}`, availableBalance: 0 },
        });
        asUser(orphan);
        const add = await addEntry(null, { partyName: 'Ghost party' });
        expect(add.status).toBe(403);
        const list = await listEntries();
        expect(list.status).toBe(403);
    });
});
