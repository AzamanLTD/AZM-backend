// __tests__/r32-hotel-room-mutation-authority.test.js
// =============================================================================
// r32 audit item B — HOTEL ROOM MUTATION AUTHORITY (real PostgreSQL proofs).
//
// Historical defect: HotelOpsService.updateRoom(roomId, data) ignored the
// route's businessProfileId argument and mutated by bare { id } — the tenant
// check existed only in the surrounding pre-read, not at the mutation
// boundary. The generic method also accepted `status`, bypassing the
// dedicated room-status authority (updateRoomStatus).
//
// Fixed contract:
//   • updateRoom REQUIRES businessProfileId;
//   • the room resolves by { id, businessProfileId } before any write;
//   • a foreign room is refused (Room not found.);
//   • generic PATCH can never set status — updateRoomStatus is the only
//     room-state authority (and the r31 MAINTENANCE trigger still guards it).
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
const { seedBusiness, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r32 B — hotel room mutation authority (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(() => { process.env.DATABASE_URL = url; db = new PrismaClient(); });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => db.$executeRawUnsafe('TRUNCATE TABLE "Reservation", "HotelRoomBlock", "HotelRoom", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'));

    const room = async (biz, extra = {}) => db.hotelRoom.create({
        data: {
            businessProfileId: biz.id, roomNumber: `R32-${++seq}`, roomType: 'STANDARD',
            capacity: 2, status: 'AVAILABLE', basePriceUsdc: '10', amenities: [], imageUrls: [],
            ...extra,
        },
    });

    test('1. foreign room update refused at the mutation boundary', async () => {
        const { biz: bizA } = await seedBusiness(db);
        const { biz: bizB } = await seedBusiness(db);
        const r = await room(bizA);
        const svc = new HotelOpsService(db);

        await expect(svc.updateRoom(r.id, { roomType: 'SUITE' }, bizB.id)).rejects.toThrow('Room not found.');
        // Nothing was mutated by the foreign attempt.
        const after = await db.hotelRoom.findUnique({ where: { id: r.id } });
        expect(after.roomType).toBe('STANDARD');
    });

    test('2. same-business metadata update succeeds', async () => {
        const { biz } = await seedBusiness(db);
        const r = await room(biz);
        const svc = new HotelOpsService(db);

        const updated = await svc.updateRoom(r.id, { roomType: 'DELUXE', floor: 3, basePriceUsdc: 12.5 }, biz.id);
        expect(updated.roomType).toBe('DELUXE');
        expect(updated.floor).toBe(3);
        const after = await db.hotelRoom.findUnique({ where: { id: r.id } });
        expect(after.roomType).toBe('DELUXE');
        expect(Number(after.basePriceUsdc)).toBe(12.5);
    });

    test('3. generic PATCH containing status fails closed (no partial mutation)', async () => {
        const { biz } = await seedBusiness(db);
        const r = await room(biz);
        const svc = new HotelOpsService(db);

        await expect(svc.updateRoom(r.id, { roomType: 'SUITE', status: 'MAINTENANCE' }, biz.id))
            .rejects.toThrow(/room status authority/i);
        // The whole PATCH failed closed — the smuggled status did not mutate
        // and neither did the legitimate metadata field.
        const after = await db.hotelRoom.findUnique({ where: { id: r.id } });
        expect(after.status).toBe('AVAILABLE');
        expect(after.roomType).toBe('STANDARD');
    });

    test('4. status remains reachable ONLY through the dedicated status authority', async () => {
        const { biz } = await seedBusiness(db);
        const r = await room(biz);
        const svc = new HotelOpsService(db);

        const viaAuthority = await svc.updateRoomStatus(r.id, 'MAINTENANCE', 'pipe leak', biz.id);
        expect(viaAuthority.status).toBe('MAINTENANCE');

        // The dedicated authority is itself tenant-guarded:
        const { biz: bizB } = await seedBusiness(db);
        await expect(svc.updateRoomStatus(r.id, 'AVAILABLE', null, bizB.id)).rejects.toThrow('Room not found.');
        const after = await db.hotelRoom.findUnique({ where: { id: r.id } });
        expect(after.status).toBe('MAINTENANCE');
    });

    test('5. r31 compatibility: metadata updates never touch the status trigger contract; MAINTENANCE guard still enforced', async () => {
        const { biz, product } = await seedBusiness(db);
        const customer = await seedUser(db, { availableBalance: 0 });
        const r = await room(biz);
        const svc = new HotelOpsService(db);

        // A live future booking on the room.
        const base = Date.now() + 7 * 86400000;
        await db.reservation.create({
            data: {
                reservationRef: `RES-R32-${++seq}`, businessProfileId: biz.id, customerId: customer.id,
                serviceItemId: r.id, amountUsdc: 100, depositUsdc: 0,
                startDatetime: new Date(base), endDatetime: new Date(base + 86400000),
                status: 'CONFIRMED',
            },
        });

        // The r31 trigger still refuses MAINTENANCE on a booked room — the
        // status authority remains the only path and remains guarded.
        await expect(svc.updateRoomStatus(r.id, 'MAINTENANCE', null, biz.id)).rejects.toThrow();
        // Metadata PATCHes on the same room are unaffected by the trigger and
        // do not interfere with the booking invariant.
        const updated = await svc.updateRoom(r.id, { roomType: 'EXECUTIVE' }, biz.id);
        expect(updated.roomType).toBe('EXECUTIVE');
        expect(updated.status).toBe('AVAILABLE');

        // Concurrent metadata updates converge (last write wins is acceptable
        // for metadata) and never duplicate or corrupt occupancy fields.
        await Promise.allSettled([
            svc.updateRoom(r.id, { floor: 2 }, biz.id),
            svc.updateRoom(r.id, { floor: 5 }, biz.id),
        ]);
        const after = await db.hotelRoom.findUnique({ where: { id: r.id } });
        expect([2, 5]).toContain(after.floor);
        expect(after.currentReservationId).toBeNull();
        expect(after.status).toBe('AVAILABLE');
    });

    test('missing business scope is refused, not defaulted to global', async () => {
        const { biz } = await seedBusiness(db);
        const r = await room(biz);
        const svc = new HotelOpsService(db);
        await expect(svc.updateRoom(r.id, { roomType: 'SUITE' })).rejects.toThrow('Business profile context is required.');
        await expect(svc.updateRoom(r.id, { roomType: 'SUITE' }, null)).rejects.toThrow('Business profile context is required.');
        const after = await db.hotelRoom.findUnique({ where: { id: r.id } });
        expect(after.roomType).toBe('STANDARD');
    });
});
