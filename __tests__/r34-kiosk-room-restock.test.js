// __tests__/r34-kiosk-room-restock.test.js
// =============================================================================
// r34 — KIOSK AUTHORITY + ROOM-STATUS AUTHORITY + RESTOCK POSTING UNIT
// (real PostgreSQL).
//
//   E     kiosk: employeeId is never a credential (PIN or the scoped
//         kioskToken capability required); business A cannot touch business
//         B's employees/shifts; concurrent clock-ins converge on ONE open
//         shift; concurrent clock-outs complete exactly once and increment
//         stats exactly once; PIN brute-force is ceilinged; pin-auth is
//         scoped to the caller's effective business and issues the real
//         server-verifiable capability.
//   F     room status: occupancy-aware CAS — AVAILABLE never fabricated on
//         a reservation-held room, OCCUPIED never fabricated on a free one,
//         foreign rooms 404, and a claim race cannot desync the occupancy
//         projection; walk-in claims are conditional; housekeeping
//         completion never forces an occupied room AVAILABLE.
//   G/H   restock: exact totals below the ledger's representable unit are
//         REJECTED instead of silently rounding to a zero posting; ≥-unit
//         16dp totals post with explicit rounding evidence; zero-cost
//         restocks stay truthful; replay survives item soft-retirement; and
//         the application exposes NO hard-delete route for inventory items
//         (the idempotency-claim durability lifecycle is soft-retirement).
// =============================================================================
const express = require('express');
const request = require('supertest');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => {
        req.user = global.__R34_USER;
        next();
    },
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (_req, _res, next) => next(),
}));

const router = require('../routes/businessOSRoutes');
const kioskPinGuard = require('../utils/kioskPinGuard');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

let db;
let seq = 0;
const uniq = () => `r34k-${Date.now()}-${++seq}`;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.set('prisma', db);
    app.use('/api/business-os', router);
    return app;
}

async function mkUser(prefix, role = 'VENDOR') {
    const hash = await bcrypt.hash('TestPass1!secure', 10);
    const id = uniq();
    return db.user.create({
        data: { username: `${prefix}_${id}`, email: `${id}@test.com`, password: hash, azamanId: `AZM-${id}`, role },
    });
}

async function mkBusiness(owner, name) {
    return db.businessProfile.create({
        data: {
            userId: owner.id, bizId: `BIZ-${uniq()}`, businessName: name,
            category: 'HOSPITALITY', isVerified: true, kybStatus: 'VERIFIED',
        },
    });
}

async function mkEmployeeWithPin(businessProfileId, userId, pin) {
    return db.businessEmployee.create({
        data: {
            businessProfileId, userId, role: 'STAFF', status: 'ACTIVE',
            permissions: ['shifts.view'], pinCode: await bcrypt.hash(pin, 10),
        },
    });
}

function as(user) {
    global.__R34_USER = user ? { id: user.id, username: user.username, role: user.role } : null;
    return makeApp();
}

const api = (app) => request(app);

run('r34 — kiosk authority (real PostgreSQL)', () => {
    let ownerA, ownerB, businessA, businessB, empA1, empA2, empB, userA1, userA2, userB1;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R34_USER = null;
        kioskPinGuard.__reset();
        await db.$executeRawUnsafe(
            'TRUNCATE TABLE "Shift", "BusinessEmployee", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
        );
    });

    beforeEach(async () => {
        ownerA = await mkUser('kownA');
        ownerB = await mkUser('kownB');
        businessA = await mkBusiness(ownerA, 'Kiosk Biz A');
        businessB = await mkBusiness(ownerB, 'Kiosk Biz B');
        userA1 = await mkUser('kempU1', 'USER');
        userA2 = await mkUser('kempU2', 'USER');
        userB1 = await mkUser('kempB1', 'USER');
        empA1 = await mkEmployeeWithPin(businessA.id, userA1.id, '1111');
        empA2 = await mkEmployeeWithPin(businessA.id, userA2.id, '2222');
        empB = await mkEmployeeWithPin(businessB.id, userB1.id, '9999');
    });

    const clockIn = (app, body) => api(app).post('/api/business-os/kiosk/clock-in').send(body);
    const clockOut = (app, body) => api(app).post('/api/business-os/kiosk/clock-out').send(body);

    test('E1: employeeId alone is not a credential — 401 without PIN or kioskToken', async () => {
        const res = await clockIn(as(ownerA), { employeeId: empA1.id });
        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/PIN required/);
        expect(await db.shift.findMany({ where: { employeeId: empA1.id } })).toHaveLength(0);
    });

    test('E2: correct PIN clocks in; wrong PIN fails closed; foreign employee is not found', async () => {
        const app = as(ownerA);
        const ok = await clockIn(app, { employeeId: empA1.id, pinCode: '1111' });
        expect(ok.status).toBe(200);
        expect(ok.body.shift.status).toBe('CLOCKED_IN');
        expect(ok.body.shift.clockInTime).not.toBeNull();

        // Second employee with the FIRST employee's PIN must fail.
        const wrongPin = await clockIn(app, { employeeId: empA2.id, pinCode: '1111' });
        expect(wrongPin.status).toBe(401);
        expect(await db.shift.findMany({ where: { employeeId: empA2.id } })).toHaveLength(0);

        // B's kiosk cannot see A's employee even with the right PIN.
        const before = await db.shift.count({ where: { employeeId: empA1.id } });
        const foreign = await clockIn(as(ownerB), { employeeId: empA1.id, pinCode: '1111' });
        expect(foreign.status).toBe(404);
        expect(await db.shift.count({ where: { employeeId: empA1.id } })).toBe(before);
    });

    test('E3: concurrent clock-ins converge on exactly ONE open shift', async () => {
        const app = as(ownerA);
        const results = await Promise.all([
            clockIn(app, { employeeId: empA1.id, pinCode: '1111' }),
            clockIn(app, { employeeId: empA1.id, pinCode: '1111' }),
            clockIn(app, { employeeId: empA1.id, pinCode: '1111' }),
        ]);
        results.forEach((r) => expect(r.status).toBe(200));
        const shifts = await db.shift.findMany({ where: { employeeId: empA1.id, status: { in: ['CLOCKED_IN', 'LATE'] } } });
        expect(shifts).toHaveLength(1);
    });

    test('E4: concurrent clock-outs complete exactly once and increment stats exactly once', async () => {
        const app = as(ownerA);
        await clockIn(app, { employeeId: empA1.id, pinCode: '1111' });
        // Backdate the clock-in by 65 minutes so the completed shift carries
        // a real duration (clock-in/out in the same second is 0h by design).
        await db.shift.updateMany({
            where: { employeeId: empA1.id, status: { in: ['CLOCKED_IN', 'LATE'] } },
            data: { clockInTime: new Date(Date.now() - 65 * 60000) },
        });

        const results = await Promise.all([
            clockOut(app, { employeeId: empA1.id, pinCode: '1111' }),
            clockOut(app, { employeeId: empA1.id, pinCode: '1111' }),
            clockOut(app, { employeeId: empA1.id, pinCode: '1111' }),
        ]);
        const okCount = results.filter((r) => r.status === 200).length;
        const rejected = results.filter((r) => r.status !== 200);
        expect(okCount).toBe(1);
        expect(rejected.length).toBe(2);
        rejected.forEach((r) => expect([404, 409]).toContain(r.status));

        const completed = await db.shift.findMany({ where: { employeeId: empA1.id, status: 'CLOCKED_OUT' } });
        expect(completed).toHaveLength(1);
        const emp = await db.businessEmployee.findUnique({ where: { id: empA1.id } });
        expect(emp.totalShifts).toBe(1); // incremented exactly once
        expect(Number(emp.totalHours)).toBeGreaterThanOrEqual(1); // 65 min backdated
    });

    test('E5: clock-out cannot be hijacked by employeeId alone or another employee with their own PIN', async () => {
        const app = as(ownerA);
        await clockIn(app, { employeeId: empA1.id, pinCode: '1111' });
        await clockIn(app, { employeeId: empA2.id, pinCode: '2222' });

        // empA2's id with empA2's own PIN is fine (their own shift).
        const own = await clockOut(app, { employeeId: empA2.id, pinCode: '2222' });
        expect(own.status).toBe(200);

        // empA1's shift cannot be closed using empA2's (wrong) PIN.
        const hijack = await clockOut(app, { employeeId: empA1.id, pinCode: '2222' });
        expect(hijack.status).toBe(401);
        const stillOpen = await db.shift.findFirst({ where: { employeeId: empA1.id, status: { in: ['CLOCKED_IN', 'LATE'] } } });
        expect(stillOpen).not.toBeNull();
        expect(stillOpen.clockOutTime).toBeNull();

        // Business B cannot close A's shift.
        const foreign = await clockOut(as(ownerB), { employeeId: empA1.id, pinCode: '1111' });
        expect(foreign.status).toBe(404);
        expect((await db.shift.findFirst({ where: { employeeId: empA1.id, status: { in: ['CLOCKED_IN', 'LATE'] } } })).clockOutTime).toBeNull();
    });

    test('E6: pin-auth is scoped to the caller business, issues a verifiable capability, and rejects foreign body ids', async () => {
        const app = as(ownerA);
        const foreignBiz = await api(app).post('/api/business-os/kiosk/pin-auth')
            .send({ pinCode: '1111', businessProfileId: businessB.id });
        expect(foreignBiz.status).toBe(403);

        const ok = await api(app).post('/api/business-os/kiosk/pin-auth')
            .send({ pinCode: '1111', businessProfileId: businessA.id });
        expect(ok.status).toBe(200);
        expect(ok.body.businessProfileId).toBe(businessA.id);
        expect(ok.body.kioskToken).toBeTruthy();
        expect(ok.body.employee.id).toBe(empA1.id);

        // The token authorizes clock-in with NO PIN supplied.
        const inRes = await clockIn(app, { employeeId: empA1.id, kioskToken: ok.body.kioskToken });
        expect(inRes.status).toBe(200);
        expect(inRes.body.shift.status).toBe('CLOCKED_IN');

        // The token cannot be replayed for a DIFFERENT employee.
        const crossUse = await clockIn(app, { employeeId: empA2.id, kioskToken: ok.body.kioskToken });
        expect(crossUse.status).toBe(401);

        // A tampered/invalid token is rejected.
        const forged = await clockIn(app, { employeeId: empA1.id, kioskToken: 'not-a-jwt' });
        expect(forged.status).toBe(401);
    });

    test('E7: PIN brute force hits the attempt ceiling (per-business for pin-auth, per-employee for named clock-in)', async () => {
        const app = as(ownerA);
        for (let i = 0; i < 5; i += 1) {
            const r = await api(app).post('/api/business-os/kiosk/pin-auth').send({ pinCode: '0000' });
            expect(r.status).toBe(401);
        }
        const locked = await api(app).post('/api/business-os/kiosk/pin-auth').send({ pinCode: '1111' });
        expect(locked.status).toBe(429);

        kioskPinGuard.__reset();
        for (let i = 0; i < 5; i += 1) {
            const r = await clockIn(app, { employeeId: empA1.id, pinCode: '0000' });
            expect(r.status).toBe(401);
        }
        const lockedEmp = await clockIn(app, { employeeId: empA1.id, pinCode: '1111' });
        expect(lockedEmp.status).toBe(429);
        // The lock is per-employee: empA2 is unaffected.
        const other = await clockIn(app, { employeeId: empA2.id, pinCode: '2222' });
        expect(other.status).toBe(200);
    });

    test('E8: a user with no business context cannot use the kiosk', async () => {
        const outsider = await mkUser('noBiz');
        const res = await clockIn(as(outsider), { employeeId: empA1.id, pinCode: '1111' });
        expect(res.status).toBe(403);
        expect(await db.shift.findMany({ where: { employeeId: empA1.id } })).toHaveLength(0);
    });
});

run('r34 — room-status authority (real PostgreSQL)', () => {
    let biz, svc;
    const mkRoom = (extra = {}) => db.hotelRoom.create({
        data: { businessProfileId: biz.id, roomNumber: `R${++seq}`, roomType: 'STANDARD', status: 'AVAILABLE', basePriceUsdc: 100, ...extra },
    });

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe(
            'TRUNCATE TABLE "HotelHousekeepingTask", "HotelRoomBlock", "Reservation", "HotelRoom", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
        );
    });

    beforeEach(async () => {
        const owner = await mkUser('hown');
        biz = await mkBusiness(owner, 'Hotel r34');
        svc = new HotelOpsService(db);
    });

    test('F1: status updates are tenant-scoped and occupancy-aware', async () => {
        const room = await mkRoom();
        const room2 = await mkRoom();
        // foreign business room
        const otherOwner = await mkUser('hoth');
        const otherBiz = await mkBusiness(otherOwner, 'Other Hotel');
        const otherRoom = await db.hotelRoom.create({
            data: { businessProfileId: otherBiz.id, roomNumber: 'X1', roomType: 'STANDARD', basePriceUsdc: 100 },
        });
        await expect(svc.updateRoomStatus(otherRoom.id, 'MAINTENANCE', null, biz.id)).rejects.toThrow('Room not found');

        // free room → MAINTENANCE ok
        await svc.updateRoomStatus(room2.id, 'MAINTENANCE', 'painting', biz.id);
        expect((await db.hotelRoom.findUnique({ where: { id: room2.id } })).status).toBe('MAINTENANCE');

        // free room → OCCUPIED refused (occupancy projection would lie)
        await expect(svc.updateRoomStatus(room2.id, 'OCCUPIED', null, biz.id)).rejects.toThrow();
        expect((await db.hotelRoom.findUnique({ where: { id: room2.id } })).status).toBe('MAINTENANCE');

        // The r31 capacity trigger requires the room to be AVAILABLE when a
        // CHECKED_IN reservation is created, so reserve first, then hold.
        const guest = await mkUser('guest');
        const resv = await db.reservation.create({
            data: {
                reservationRef: `RES-${uniq().toUpperCase()}`,
                businessProfileId: biz.id, customerId: guest.id, serviceItemId: room.id,
                startDatetime: new Date(Date.now() + 3600000), endDatetime: new Date(Date.now() + 7200000),
                status: 'CHECKED_IN', amountUsdc: 100, depositUsdc: 0,
            },
        });
        await db.hotelRoom.update({ where: { id: room.id }, data: { status: 'OCCUPIED', currentReservationId: resv.id } });

        // reservation-held room → AVAILABLE refused
        await expect(svc.updateRoomStatus(room.id, 'AVAILABLE', null, biz.id)).rejects.toThrow();
        const held = await db.hotelRoom.findUnique({ where: { id: room.id } });
        expect(held.status).toBe('OCCUPIED');
        expect(held.currentReservationId).toBe(resv.id);
        // Transient states on a held room remain allowed — the r31
        // azm_room_status_trigger only forbids MAINTENANCE superseding a
        // committed future booking. CLEANING is a legitimate transient state
        // on a held room; the occupancy projection stays truthful.
        await svc.updateRoomStatus(room.id, 'CLEANING', 'mid-stay refresh', biz.id);
        expect((await db.hotelRoom.findUnique({ where: { id: room.id } })).status).toBe('CLEANING');
        expect((await db.hotelRoom.findUnique({ where: { id: room.id } })).currentReservationId).toBe(resv.id);
        // And the r31 trigger's own rule: MAINTENANCE on a booked room is
        // refused at the database boundary — the service cannot smuggle it
        // past with a status-only CAS.
        await expect(svc.updateRoomStatus(room.id, 'MAINTENANCE', 'painting', biz.id)).rejects.toThrow();
        expect((await db.hotelRoom.findUnique({ where: { id: room.id } })).status).toBe('CLEANING');
        expect((await db.hotelRoom.findUnique({ where: { id: room.id } })).currentReservationId).toBe(resv.id);
    });

    test('F2: walk-in claims are conditional — concurrent walk-ins cannot double-book a room', async () => {
        const room = await mkRoom();
        const g1 = await mkUser('g1');
        const g2 = await mkUser('g2');
        const slot = { startDatetime: new Date(Date.now() + 3600000), endDatetime: new Date(Date.now() + 7200000) };

        const [w1, w2] = await Promise.allSettled([
            svc.createWalkIn(biz.id, { customerId: g1.id, roomId: room.id, nights: 1 }),
            svc.createWalkIn(biz.id, { customerId: g2.id, roomId: room.id, nights: 1 }),
        ]);
        const winners = [w1, w2].filter((r) => r.status === 'fulfilled');
        const losers = [w1, w2].filter((r) => r.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);

        const after = await db.hotelRoom.findUnique({ where: { id: room.id } });
        expect(after.status).toBe('OCCUPIED');
        expect(after.currentReservationId).toBe(winners[0].value.id);
        const reservations = await db.reservation.findMany({ where: { businessProfileId: biz.id, serviceItemId: room.id } });
        expect(reservations).toHaveLength(1);
    });

    test('F3: housekeeping completion never forces a re-occupied room AVAILABLE', async () => {
        const room = await mkRoom({ status: 'CLEANING' });
        const hkUser = await mkUser('hk');
        const emp = await db.businessEmployee.create({
            data: { businessProfileId: biz.id, userId: hkUser.id, role: 'STAFF', status: 'ACTIVE', permissions: ['housekeeping.manage'] },
        });
        const task = await db.hotelHousekeepingTask.create({
            data: { businessProfileId: biz.id, roomId: room.id, taskType: 'CHECKOUT_CLEAN', status: 'IN_PROGRESS', employeeId: emp.id },
        });

        // While housekeeping ran, the room was turned back to AVAILABLE and
        // a walk-in claimed it (the r31 trigger requires AVAILABLE at claim).
        const guest = await mkUser('res Guest');
        await db.hotelRoom.update({ where: { id: room.id }, data: { status: 'AVAILABLE' } });
        const resv = await db.reservation.create({
            data: {
                reservationRef: `RES-${uniq().toUpperCase()}`,
                businessProfileId: biz.id, customerId: guest.id, serviceItemId: room.id,
                startDatetime: new Date(), endDatetime: new Date(Date.now() + 3600000),
                status: 'CHECKED_IN', amountUsdc: 100, depositUsdc: 0,
            },
        });
        await db.hotelRoom.update({ where: { id: room.id }, data: { status: 'OCCUPIED', currentReservationId: resv.id } });

        const done = await svc.completeHousekeeping(task.id, { notes: 'cleaned' }, biz.id);
        expect(done.status).toBe('COMPLETED');

        const after = await db.hotelRoom.findUnique({ where: { id: room.id } });
        // The occupancy projection survives: still OCCUPIED, still held.
        expect(after.status).toBe('OCCUPIED');
        expect(after.currentReservationId).toBe(resv.id);
    });
});

run('r34 — restock posting unit + durability lifecycle (real PostgreSQL)', () => {
    let biz, svc;
    const mkItem = (extra = {}) => db.inventoryItem.create({
        data: { businessProfileId: biz.id, name: `Item ${++seq}`, unit: 'kg', currentStock: 10, minimumStock: 0, costPerUnit: 2.5, ...extra },
    });

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        svc = new InventoryRestockService(db);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        await db.$executeRawUnsafe(
            'TRUNCATE TABLE "InventoryRestockOperation", "BusinessLedgerEntry", "InventoryItem", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
        );
    });

    beforeEach(async () => {
        const owner = await mkUser('rown');
        biz = await mkBusiness(owner, 'Restock r34');
    });

    const key = () => `k-${uniq()}`;

    test('G1: a non-zero exact total below the ledger unit is REJECTED, not zero-posted', async () => {
        const item = await mkItem({ costPerUnit: 0.00000001 });
        await expect(svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '0.00000001', costPerUnit: '0.00000001', idempotencyKey: key() }))
            .rejects.toThrow(/smallest representable unit/);
        // Nothing was written: no stock change, no ledger row, no claim.
        expect((await db.inventoryItem.findUnique({ where: { id: item.id } })).currentStock).toBe(10);
        expect(await db.businessLedgerEntry.findMany({ where: { businessProfileId: biz.id } })).toHaveLength(0);
        expect(await db.inventoryRestockOperation.findMany({ where: { businessProfileId: biz.id } })).toHaveLength(0);
    });

    test('G2: a 16dp total at/above the unit posts with explicit rounding evidence', async () => {
        const item = await mkItem({ costPerUnit: 0.00000002 });
        const out = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '1.12345678', costPerUnit: '0.00000002', idempotencyKey: key() });
        const ledger = await db.businessLedgerEntry.findFirst({ where: { businessProfileId: biz.id, sourceType: 'INVENTORY_RESTOCK' } });
        // The posted amount is the exact product rounded to 8dp: 2e-8.
        expect(Number(ledger.amount)).toBe(-2e-8); // exact product rounded to 8dp
        // The exact product and the posted amount are BOTH durable evidence.
        expect(Number(ledger.metadata.totalCostGhs)).toBeCloseTo(2.24691356e-8, 24);
        expect(Number(ledger.metadata.postedAmountGhs)).toBeCloseTo(2e-8, 24);
        expect(Number(out.totalCostGhs)).toBeCloseTo(0.0000000224691356, 20);
    });

    test('G3: zero-cost restocks stay truthful (exact zero posting)', async () => {
        const item = await mkItem();
        const out = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '3', costPerUnit: '0', idempotencyKey: key() });
        const ledger = await db.businessLedgerEntry.findFirst({ where: { businessProfileId: biz.id, sourceType: 'INVENTORY_RESTOCK' } });
        expect(ledger.amount.toString()).toBe('0');
        expect(ledger.metadata.totalCostGhs).toBe('0');
        expect((await db.inventoryItem.findUnique({ where: { id: item.id } })).currentStock).toBe(13);
    });

    test('H1: replay survives item soft-retirement; new restocks on retired items fail closed', async () => {
        const item = await mkItem();
        const k = key();
        const first = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '2', costPerUnit: '5', idempotencyKey: k });
        expect(first.ledgerWritten).toBe(true);

        // Soft-retire the item (the documented lifecycle; there is no
        // hard-delete route anywhere in the application).
        await db.inventoryItem.update({ where: { id: item.id }, data: { isActive: false } });

        // A replay of the committed key still returns the committed result —
        // the idempotency claim outlives catalog state.
        const replay = await svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '2', costPerUnit: '5', idempotencyKey: k });
        expect(replay.operationId).toBe(first.operationId);
        // No second posting.
        expect(await db.businessLedgerEntry.findMany({ where: { businessProfileId: biz.id, sourceType: 'INVENTORY_RESTOCK' } })).toHaveLength(1);

        // A NEW restock against the retired item is refused.
        await expect(svc.restock({ businessProfileId: biz.id, itemId: item.id, quantity: '1', costPerUnit: '5', idempotencyKey: key() }))
            .rejects.toThrow(/inactive/i);
    });

    test('H2: the application exposes NO hard-delete route for inventory items (soft-retirement is the lifecycle)', () => {
        const routes = router.stack
            .filter((l) => l.route && /^\/restaurant\/inventory/.test(l.route.path))
            .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
        routes.forEach((r) => expect(r.startsWith('DELETE')).toBe(false));
        expect(routes.some((r) => r.startsWith('PATCH'))).toBe(true);
    });
});
