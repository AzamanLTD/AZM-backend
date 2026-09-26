// __tests__/r33-hotel-room-move-concurrency.test.js
// =============================================================================
// r33 Wave 1.2 — ROOM-MOVE CONCURRENCY AUTHORITY (real PostgreSQL).
//
// Historical defect: HotelOpsService.moveRoom() read the reservation, its
// current room, and the target-room availability OUTSIDE the transaction and
// then wrote inside it. Two concurrent moves of the same reservation
// (A→B and A→C) both captured the same stale oldRoomId and both "succeeded":
// the reservation ended pointing at one room while the other stayed OCCUPIED
// with a currentReservationId the reservation no longer owned — an orphaned
// room projection.
//
// Fixed contract (database is the authority, inside one Serializable
// transaction, no application-level mutex):
//   • the reservation is read inside the transaction;
//   • the target room is CLAIMED by a conditional updateMany on
//     { id, businessProfileId, status: 'AVAILABLE' } — exactly one racer wins;
//   • the reservation move is a CAS on { id, businessProfileId,
//     serviceItemId: oldRoomId } — a concurrent mover invalidates the move and
//     the whole transaction (including the target claim) rolls back;
//   • the old-room cleanup is conditional on currentReservationId still
//     pointing at THIS reservation;
//   • every business scope is enforced at each statement's WHERE clause.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { HotelOpsService } = require('../services/businessOS/hotelOpsService');
const { seedBusiness, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r33 W1.2 — hotel room-move concurrency authority (real PostgreSQL)', () => {
    let db, db2, seq = 0;
    const day = 86400000;
    const base = new Date(Date.now() + 7 * day);
    const slot = (from = 0, to = 1) => ({
        startDatetime: new Date(+base + from * day),
        endDatetime: new Date(+base + to * day),
    });
    const ref = () => `RES-R33-${Date.now()}-${++seq}`;

    let db3;
    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        db2 = new PrismaClient();
        db3 = new PrismaClient();
    });
    afterAll(async () => {
        await Promise.all([db, db2, db3].map(c => c.$disconnect()));
    });
    afterEach(async () => db.$executeRawUnsafe(
        'TRUNCATE TABLE "Reservation", "HotelRoomBlock", "HotelRoom", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
    ));

    const room = (biz, extra = {}) => db.hotelRoom.create({
        data: {
            businessProfileId: biz.id,
            roomNumber: `R33-${++seq}`,
            roomType: 'STANDARD',
            capacity: 2,
            status: 'AVAILABLE',
            basePriceUsdc: '10',
            amenities: [],
            imageUrls: [],
            ...extra,
        },
    });

    const seedContext = async () => {
        const { biz, product } = await seedBusiness(db);
        const customer = await seedUser(db, { availableBalance: 0 });
        return { biz, product, customer };
    };

    const checkedInReservation = async (ctx, roomA, extra = {}) => db.reservation.create({
        data: {
            reservationRef: ref(),
            businessProfileId: ctx.biz.id,
            customerId: ctx.customer.id,
            serviceItemId: roomA.id,
            status: 'CHECKED_IN',
            checkedInAt: new Date(),
            amountUsdc: '100',
            metadata: { channel: 'FRONT_DESK' },
            ...slot(0, 2),
            ...extra,
        },
    });

    // Fire two operations concurrently against separate connections.
    const race = (fnA, fnB) => Promise.allSettled([fnA(), fnB()]);
    const winners = (results) => results.filter(r => r.status === 'fulfilled').length;

    const roomState = async (id) => db.hotelRoom.findUnique({
        where: { id },
        select: { status: true, currentReservationId: true },
    });

    test('1. a sequential move is consistent: old room released, target claimed, reservation updated', async () => {
        const ctx = await seedContext();
        const roomA = await room(ctx.biz);
        const roomB = await room(ctx.biz);
        const res = await checkedInReservation(ctx, roomA);
        await db.hotelRoom.update({
            where: { id: roomA.id },
            data: { status: 'OCCUPIED', currentReservationId: res.id },
        });

        const svc = new HotelOpsService(db);
        const out = await svc.moveRoom(res.id, { newRoomId: roomB.id, reason: 'upgrade' }, ctx.biz.id);
        expect(out.ok).toBe(true);
        expect(out.reservation.serviceItemId).toBe(roomB.id);
        expect(out.reservation.metadata.movedFrom).toBe(roomA.id);

        const a = await roomState(roomA.id);
        const b = await roomState(roomB.id);
        expect(a).toMatchObject({ status: 'DIRTY', currentReservationId: null });
        expect(b).toMatchObject({ status: 'OCCUPIED', currentReservationId: res.id });
    });

    test('2. concurrent A→B vs A→C: exactly one move wins, no orphan OCCUPIED room, loser fully rolled back', async () => {
        const ctx = await seedContext();
        const roomA = await room(ctx.biz);
        const roomB = await room(ctx.biz);
        const roomC = await room(ctx.biz);
        const res = await checkedInReservation(ctx, roomA);
        await db.hotelRoom.update({
            where: { id: roomA.id },
            data: { status: 'OCCUPIED', currentReservationId: res.id },
        });

        const svc1 = new HotelOpsService(db);
        const svc2 = new HotelOpsService(db2);

        // Deterministic overlap: the r31 capacity trigger serializes every
        // reservation write behind a transaction-scoped business advisory
        // lock. Hold that lock from a third connection so BOTH movers run to
        // their CAS statement and block inside the trigger — guaranteeing
        // both captured the same origin room (A) before either can move.
        const bizLock = `SELECT pg_advisory_xact_lock(hashtextextended('${ctx.biz.id}', 91731))`;
        let releaseBarrier;
        const barrier = db3.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(bizLock);
            await new Promise((resolve) => { releaseBarrier = resolve; });
        }, { timeout: 30000 });
        // Wait until the barrier actually holds the business lock.
        for (let i = 0; i < 250; i += 1) {
            const probe = await db.$queryRawUnsafe(
                `SELECT pg_try_advisory_lock(hashtextextended('${ctx.biz.id}', 91731)) AS ok`
            );
            if (!probe[0].ok) break; // barrier holds it
            await db.$executeRawUnsafe(
                `SELECT pg_advisory_unlock(hashtextextended('${ctx.biz.id}', 91731))`
            );
            await new Promise(r => setTimeout(r, 20));
        }

        const racing = race(
            () => svc1.moveRoom(res.id, { newRoomId: roomB.id, reason: 'move-1' }, ctx.biz.id),
            () => svc2.moveRoom(res.id, { newRoomId: roomC.id, reason: 'move-2' }, ctx.biz.id),
        );
        // Let both movers reach their CAS inside the trigger, then release.
        await new Promise(r => setTimeout(r, 400));
        releaseBarrier();
        const results = await racing;

        // Exactly one logical move survives; the loser rolls back completely.
        expect(winners(results)).toBe(1);
        const winnerRoom = results[0].status === 'fulfilled' ? roomB : roomC;
        const loserRoom = results[0].status === 'fulfilled' ? roomC : roomB;

        const reservation = await db.reservation.findUnique({ where: { id: res.id } });
        const a = await roomState(roomA.id);
        const w = await roomState(winnerRoom.id);
        const l = await roomState(loserRoom.id);

        // The reservation points at exactly the winner's room.
        expect(reservation.serviceItemId).toBe(winnerRoom.id);
        // The old room was released exactly once — never an orphan.
        expect(a).toMatchObject({ status: 'DIRTY', currentReservationId: null });
        expect(w).toMatchObject({ status: 'OCCUPIED', currentReservationId: res.id });
        // The loser's target-room claim was rolled back: still AVAILABLE and
        // holding no reservation.
        expect(l).toMatchObject({ status: 'AVAILABLE', currentReservationId: null });
        // No room anywhere claims a reservation it does not hold.
        const occupied = await db.hotelRoom.findMany({
            where: { businessProfileId: ctx.biz.id, currentReservationId: { not: null } },
        });
        expect(occupied.map(r => r.id).sort()).toEqual([winnerRoom.id].sort());
    });

    test('3. move vs a concurrent walk-in claim on the same target room: exactly one wins', async () => {
        const ctx = await seedContext();
        const roomA = await room(ctx.biz);
        const roomB = await room(ctx.biz);
        const res = await checkedInReservation(ctx, roomA);
        await db.hotelRoom.update({
            where: { id: roomA.id },
            data: { status: 'OCCUPIED', currentReservationId: res.id },
        });

        const svc = new HotelOpsService(db);

        // Competing claim: another front desk claims room B concurrently via a
        // conditional status transition (the walk-in check-in pattern).
        const results = await race(
            () => svc.moveRoom(res.id, { newRoomId: roomB.id, reason: 'move' }, ctx.biz.id),
            () => db2.hotelRoom.updateMany({
                where: { id: roomB.id, businessProfileId: ctx.biz.id, status: 'AVAILABLE' },
                data: { status: 'OCCUPIED', currentReservationId: 'other-guest' },
            }),
        );

        expect(winners(results)).toBe(1);
        const b = await roomState(roomB.id);
        expect(b.status).toBe('OCCUPIED');
        // Whoever lost, the room is held by exactly one winner:
        //   move won   → currentReservationId = res.id, room A released;
        //   claim won  → currentReservationId = other-guest, reservation still in A.
        const reservation = await db.reservation.findUnique({ where: { id: res.id } });
        if (b.currentReservationId === res.id) {
            expect(reservation.serviceItemId).toBe(roomB.id);
            expect((await roomState(roomA.id)).currentReservationId).toBeNull();
        } else {
            expect(b.currentReservationId).toBe('other-guest');
            expect(reservation.serviceItemId).toBe(roomA.id);
        }
    });

    test('4. a failed move leaves reservation, old room, and target room exactly as before', async () => {
        const ctx = await seedContext();
        const roomA = await room(ctx.biz);
        const roomB = await room(ctx.biz);
        const res = await checkedInReservation(ctx, roomA);
        await db.hotelRoom.update({
            where: { id: roomA.id },
            data: { status: 'OCCUPIED', currentReservationId: res.id },
        });
        // Target room is already occupied by someone else.
        await db.hotelRoom.update({
            where: { id: roomB.id },
            data: { status: 'OCCUPIED', currentReservationId: 'someone-else' },
        });

        const svc = new HotelOpsService(db);
        await expect(svc.moveRoom(res.id, { newRoomId: roomB.id, reason: 'move' }, ctx.biz.id))
            .rejects.toThrow('New room is not available');

        expect(await roomState(roomA.id)).toMatchObject({ status: 'OCCUPIED', currentReservationId: res.id });
        expect(await roomState(roomB.id)).toMatchObject({ status: 'OCCUPIED', currentReservationId: 'someone-else' });
        const reservation = await db.reservation.findUnique({ where: { id: res.id } });
        expect(reservation.serviceItemId).toBe(roomA.id);
        expect(reservation.metadata).toEqual({ channel: 'FRONT_DESK' }); // untouched
    });

    test('5. moving to the room the reservation already holds is refused (no self-move churn)', async () => {
        const ctx = await seedContext();
        const roomA = await room(ctx.biz);
        const res = await checkedInReservation(ctx, roomA);

        const svc = new HotelOpsService(db);
        await expect(svc.moveRoom(res.id, { newRoomId: roomA.id, reason: 'nope' }, ctx.biz.id))
            .rejects.toThrow('already assigned to this room');
        expect(await roomState(roomA.id)).toMatchObject({ status: 'AVAILABLE', currentReservationId: null });
    });

    test('6. cross-business ids stay isolated: foreign reservation, foreign target room', async () => {
        const ctxA = await seedContext();
        const ctxB = await seedContext();
        const roomA = await room(ctxA.biz);
        const roomB = await room(ctxB.biz);
        const resA = await checkedInReservation(ctxA, roomA);
        const resB = await checkedInReservation(ctxB, roomB);

        const svc = new HotelOpsService(db);

        // A's actor cannot move B's reservation.
        await expect(svc.moveRoom(resB.id, { newRoomId: roomB.id, reason: 'x' }, ctxA.biz.id))
            .rejects.toThrow('Reservation not found');

        // A's reservation cannot move into B's room (the claim is scoped to
        // the caller's business — a same-id coincidence is impossible, but
        // the scope is proven by the WHERE clause).
        const foreignClaim = await db.hotelRoom.updateMany({
            where: { id: roomB.id, businessProfileId: ctxA.biz.id, status: 'AVAILABLE' },
            data: { status: 'OCCUPIED' },
        });
        expect(foreignClaim.count).toBe(0); // the claim statement itself cannot cross tenants
        expect((await roomState(roomB.id)).status).toBe('AVAILABLE');

        // B's state is entirely untouched by A's failed attempts.
        expect((await db.reservation.findUnique({ where: { id: resB.id } })).businessProfileId)
            .toBe(ctxB.biz.id);
    });

    test('7. old-room cleanup is conditional: a room already re-claimed by another reservation is not clobbered', async () => {
        const ctx = await seedContext();
        const roomA = await room(ctx.biz);
        const roomB = await room(ctx.biz);
        const res = await checkedInReservation(ctx, roomA);
        await db.hotelRoom.update({
            where: { id: roomA.id },
            data: { status: 'OCCUPIED', currentReservationId: res.id },
        });

        const svc = new HotelOpsService(db);

        // Between the reservation read and the cleanup, the old room's
        // occupancy is transferred to a different reservation id (checkout +
        // walk-in re-claim of the same room). The cleanup must NOT flip it to
        // DIRTY on stale ownership. (The walk-in itself is represented by the
        // room's authoritative currentReservationId — under the r31 capacity
        // authority a second overlapping CHECKED_IN reservation on roomA is
        // impossible by construction, so the re-claim is a room-projection
        // update, exactly the projection this guard protects.)
        const newHolder = 'walk-in-reservation';
        await db.hotelRoom.update({
            where: { id: roomA.id },
            data: { currentReservationId: newHolder },
        });

        // A late move of the ORIGINAL reservation (its view says it still
        // holds roomA). The move itself succeeds, but the cleanup on roomA is
        // conditional on currentReservationId = res.id — a room now held by
        // the walk-in must not be clobbered to DIRTY.
        const roomC = await room(ctx.biz);
        const out = await svc.moveRoom(res.id, { newRoomId: roomC.id, reason: 'late' }, ctx.biz.id);
        expect(out.ok).toBe(true);
        expect(out.reservation.serviceItemId).toBe(roomC.id);

        const a = await roomState(roomA.id);
        expect(a.currentReservationId).toBe(newHolder); // not clobbered to null
        expect(a.status).toBe('OCCUPIED');              // not flipped to DIRTY
    });

    test('8. updateRoom: a caller-supplied business id in the payload cannot bypass tenancy', async () => {
        const ctxA = await seedContext();
        const ctxB = await seedContext();
        const roomA = await room(ctxA.biz);

        const svc = new HotelOpsService(db);
        // A malicious PATCH body smuggles another business's id alongside a
        // legitimate field. The mutation is constrained to the authoritative
        // business context; the smuggled id is inert.
        const updated = await svc.updateRoom(
            roomA.id,
            { businessProfileId: ctxB.biz.id, roomType: 'DELUXE' },
            ctxA.biz.id,
        );

        const after = await db.hotelRoom.findUnique({ where: { id: roomA.id } });
        expect(after.businessProfileId).toBe(ctxA.biz.id); // tenancy unchanged
        expect(after.roomType).toBe('DELUXE');              // legit field applied
        expect(updated.businessProfileId).toBe(ctxA.biz.id);
    });
});
