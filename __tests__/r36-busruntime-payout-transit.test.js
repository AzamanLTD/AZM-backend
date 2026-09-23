// __tests__/r36-busruntime-payout-transit.test.js
// =============================================================================
// r36/P1 — BUSINESS RUNTIME CRASHES + HONEST PAYOUT CONTRACT
// (real PostgreSQL, real HTTP, real requirePermission chain).
//
// Historical defects this suite pins shut:
//   • POST /finance/payout called itself a payout processor while only
//     writing an audit log. It now records a DURABLE BusinessPayoutRequest
//     (REQUESTED) in one transaction with its audit log and says exactly
//     that — and touches NO balance, history, or ledger row.
//   • Three business-OS endpoints called getBizProfileId(), a helper that
//     never existed — every call was an unhandled ReferenceError (500):
//     PATCH /transit/vehicles/:id/status, GET /transit/trips, and the
//     finance/payout route itself. All now use the real async resolver.
//   • Payout destinations are user-scoped: one user's destination id is
//     never usable by another account.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_RT_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_RT_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { seedBusiness, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36/P1 — business runtime: payout contract + transit crash fixes', () => {
    let db;
    let app;
    let A, B;
    let ownerB, otherUser;
    let vehicleA, vehicleB;
    let destA, destB;

    const asUser = (user) => { global.__R36_RT_USER__ = user ? { id: user.id } : null; };

    const payout = (body) => request(app).post('/api/business-os/finance/payout').send(body);
    const vehicleStatus = (id, status) => request(app).patch(`/api/business-os/transit/vehicles/${id}/status`).send({ status });
    const trips = () => request(app).get('/api/business-os/transit/trips');
    const mkTrip = (biz, vehicle, when = new Date()) => db.transitTrip.create({
        data: {
            businessProfileId: biz.id, vehicleId: vehicle.id,
            routeName: 'Accra-Kumasi', origin: 'Accra', destination: 'Kumasi',
            departureAt: when, fareUsdc: 25,
        },
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.set('logger', { error: () => {} });
        app.use('/api/business-os', businessOSRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R36_RT_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "BusinessPayoutRequest", "PayoutDestination", "AuditLog", "TransitTrip", "TransitVehicle", "BusinessProduct", "BusinessProfile", "TransactionHistory", "JournalEntry", "LedgerTransaction", "LedgerAccount", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        ownerB = B.owner;
        otherUser = await seedUser(db);
        asUser(A.owner);

        vehicleA = await db.transitVehicle.create({
            data: { businessProfileId: A.biz.id, type: 'VAN', capacity: 12, isActive: true },
        });
        vehicleB = await db.transitVehicle.create({
            data: { businessProfileId: B.biz.id, type: 'CAR', capacity: 4, isActive: true },
        });
        destA = await db.payoutDestination.create({
            data: { userId: A.owner.id, nickname: 'My Binance', destinationType: 'BINANCE_PAY', destinationAddress: 'binance@example.com' },
        });
        destB = await db.payoutDestination.create({
            data: { userId: ownerB.id, nickname: 'B Wallet', destinationType: 'MOMO', destinationAddress: '+233...' },
        });
    });

    describe('POST /finance/payout — the honest contract', () => {
        test('records a durable REQUESTED row + audit log and moves NO money', async () => {
            const balanceBefore = Number((await db.user.findUnique({ where: { id: A.owner.id } })).availableBalance);
            const res = await payout({ amount: 50, destination: destA.id });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toMatch(/request recorded|recorded/i);
            expect(res.body.message).toMatch(/no transfer/i);
            expect(res.body.status).toBe('REQUESTED');
            expect(res.body.payoutId).toBeTruthy();

            const row = await db.businessPayoutRequest.findUnique({ where: { id: res.body.payoutId } });
            expect(row.status).toBe('REQUESTED');
            expect(Number(row.amount)).toBeCloseTo(50, 6);
            expect(row.destinationId).toBe(destA.id);
            expect(row.requestedById).toBe(A.owner.id);
            expect(row.requestLogId).toBeTruthy();

            const log = await db.auditLog.findUnique({ where: { id: row.requestLogId } });
            expect(log.action).toBe('PAYOUT_REQUESTED');
            expect(log.actorId).toBe(A.owner.id);

            // NO money moved: balance, history, ledger all untouched.
            const balanceAfter = Number((await db.user.findUnique({ where: { id: A.owner.id } })).availableBalance);
            expect(balanceAfter).toBeCloseTo(balanceBefore, 6);
            expect(await db.transactionHistory.count({ where: { type: { not: 'DEPOSIT_CRYPTO' } } })).toBe(0);
            expect(await db.ledgerTransaction.count()).toBe(0);
        });

        test('a destination belonging to ANOTHER user is refused (404)', async () => {
            const res = await payout({ amount: 10, destination: destB.id });
            expect(res.status).toBe(404);
            expect(await db.businessPayoutRequest.count()).toBe(0);
            expect(await db.auditLog.count({ where: { action: 'PAYOUT_REQUESTED' } })).toBe(0);
        });

        test.each([[0], [-5], ['abc'], [undefined], [1e12]])('invalid amount %p → 400, nothing recorded', async (bad) => {
            const res = await payout({ amount: bad, destination: destA.id });
            expect(res.status).toBe(400);
            expect(await db.businessPayoutRequest.count()).toBe(0);
        });

        test('missing destination → 400; random destination id → 404', async () => {
            expect((await payout({ amount: 10 })).status).toBe(400);
            expect((await payout({ amount: 10, destination: 'nope' })).status).toBe(404);
        });
    });

    describe('transit runtime — the three ReferenceError crashes', () => {
        test('PATCH vehicle status on OWN vehicle works (was a 500 ReferenceError)', async () => {
            const res = await vehicleStatus(vehicleA.id, 'INACTIVE');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.vehicle.isActive).toBe(false);
            const row = await db.transitVehicle.findUnique({ where: { id: vehicleA.id } });
            expect(row.isActive).toBe(false);

            const back = await vehicleStatus(vehicleA.id, 'ACTIVE');
            expect(back.status).toBe(200);
            expect(back.body.vehicle.isActive).toBe(true);
        });

        test('PATCH vehicle status on a FOREIGN vehicle → 404, never touched', async () => {
            const res = await vehicleStatus(vehicleB.id, 'INACTIVE');
            expect(res.status).toBe(404);
            expect((await db.transitVehicle.findUnique({ where: { id: vehicleB.id } })).isActive).toBe(true);
        });

        test('GET /transit/trips works and returns ONLY this business trips (was a 500)', async () => {
            await mkTrip(A.biz, vehicleA, new Date('2026-10-01'));
            await mkTrip(B.biz, vehicleB, new Date('2026-10-02'));
            const res = await trips();
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBe(1);
            expect(res.body[0].businessProfileId).toBe(A.biz.id);
            expect(res.body[0].routeName).toBe('Accra-Kumasi');
        });

        test('a user with NO business context is refused by permission, not a crash', async () => {
            asUser(otherUser);
            // requirePermission denies first (403) — that is its designed
            // refusal path; the r36 fix guarantees it is never a 500.
            const t = await trips();
            expect([403, 404]).toContain(t.status);
            const p = await payout({ amount: 5, destination: destA.id });
            expect([403, 404]).toContain(p.status);
        });
    });
});
