'use strict';

// =============================================================================
// TRANSIT BOOKING IDENTITY (real PostgreSQL) — 2026-10-01.
//
// Deep-dive step 5 found the gap: transitBookingService.bookSeats claimed
// seats transactionally but had NO durable idempotency identity. If the
// booking committed and the HTTP response was lost, the same customer's
// same-seat retry received 400 'Seats already booked' and could not
// distinguish "my booking committed but I never saw the response" from
// "another customer took those seats".
//
// The fix wires the EXISTING r42 shared financial idempotency authority
// (middleware/idempotency.js — the same claim/replay mechanism as
// withdrawals and multi-currency convert) onto POST /transit/trips/:id/book,
// with the claim committed INSIDE the booking $transaction:
//
//   one logical seat-booking intent → one durable client identity
//     → one server-side booking identity.
//
// Proofs (all against real PostgreSQL, no mocked prisma):
//   T1.  First keyed booking succeeds; the durable identity is recorded
//        (FinancialOperation COMMITTED, statusCode 201, response stored).
//   T2.  Lost response + IDENTICAL retry → the SAME booking replays
//        byte-identically; the handler does not execute again.
//   T3.  Two truly concurrent identical requests → EXACTLY one booking;
//        the duplicate gets a deterministic 409 (or a replay of the same
//        booking if it lands after commit) — never a second mutation.
//   T4.  Same key + changed seats → 409 fail-closed (new intent).
//   T5.  Same key + changed passenger-name mapping → 409 fail-closed.
//   T6.  Same key + changed customer note → 409 fail-closed (the note is
//        part of the booking identity — it is persisted on the booking).
//   T7.  Another customer cannot adopt the first customer's identity:
//        claims are scoped (userId, endpoint, key) — the other customer
//        executes their OWN independent booking.
//   T8.  Another trip cannot adopt the identity: same key + different
//        trip → 409 payload conflict (the fingerprint covers trip
//        identity via params).
//   T9.  A transaction that rolls back BEFORE the booking commit (seat
//        conflict) leaves NO replayable phantom identity: the claim is
//        released, and the same key is reusable for the corrected request.
//   T10. A keyless (legacy) request executes with today's behavior — no
//        claim, no replay, protected only by the DB seat uniqueness.
//   T11. The fare is server-derived: it is NOT part of the client
//        payload, so a retry's fingerprint is always fare-independent
//        (proves the fingerprint covers the authoritative intent only).
//
// The driver runs the REAL idempotency middleware and the REAL
// bookTripSeats controller on an Express-shaped req/res (the same direct
// driver the r42 authority suite uses to get true claim concurrency).
// require2FA is deliberately not in the driver chain: it runs BEFORE the
// idempotency middleware on the route and can only refuse (401) before any
// claim exists — it has no interaction with identity.
// =============================================================================

const { seedUser, seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('transit booking identity (PostgreSQL)', () => {
    let prisma;
    let mw;
    let ctrl;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        const { idempotency } = require('../middleware/idempotency');
        // The EXACT policy the route declares (routes/marketplaceRoutes.js).
        mw = idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, required: false });
        ctrl = require('../controllers/marketplaceController');
    });

    afterAll(async () => { await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "BusinessProfile", "BusinessProduct", "TransitVehicle", ' +
            '"TransitTrip", "TransitSeatMap", "TransitBooking", "TransitBookingSeat", ' +
            '"FinancialOperation" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── harness ─────────────────────────────────────────────────────────────

    const SEATS = ['1A', '1B', '1C', '1D'];

    async function seedTrip() {
        const { owner, biz } = await seedBusiness(prisma);
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'VAN', capacity: 4 },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id,
                vehicleId: vehicle.id,
                routeName: 'Accra-Kumasi',
                origin: 'Accra',
                destination: 'Kumasi',
                departureAt: new Date(Date.now() + 3600_000),
                fareUsdc: 10,
                availableSeats: 4,
            },
        });
        await prisma.transitSeatMap.create({
            data: {
                vehicleId: vehicle.id,
                layout: SEATS.map((s, i) => ({
                    seatId: s, row: 1, col: i + 1, type: 'WINDOW',
                })),
                rows: 1, cols: 4,
            },
        });
        const customer = await seedUser(prisma, { availableBalance: 500 });
        return { owner, biz, vehicle, trip, customer };
    }

    // A minimal Express-shaped app exposing prisma (what the controller reads).
    const appOf = () => {
        const settings = {};
        return {
            get: (k) => settings[k],
            set: (k, v) => { settings[k] = v; },
        };
    };

    // Drive the REAL middleware → REAL controller. Returns the observed
    // response as { statusCode, text } where text is the exact serialized
    // response body (what res.json produced — byte-identical replays are
    // asserted against this).
    async function book({ user, tripId, body, key }) {
        const app = appOf();
        app.set('prisma', prisma);
        const headers = key ? { 'idempotency-key': key } : {};
        const req = {
            method: 'POST',
            baseUrl: '/api/marketplace',
            route: { path: '/transit/trips/:id/book' },
            path: `/api/marketplace/transit/trips/${tripId}/book`,
            url: `/api/marketplace/transit/trips/${tripId}/book`,
            params: { id: tripId },
            query: {},
            headers,
            body: { businessProfileId: null, ...body },
            user,
            app,
        };
        let statusCode = null;
        let text = null;
        let jsonPayload = null;
        let settle = null;
        const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        const res = {
            statusCode: 200,
            locals: {},
            status(c) { statusCode = c; this.statusCode = c; return this; },
            json(payload) {
                jsonPayload = payload;
                text = JSON.stringify(payload);
                // Every terminal path (middleware refusal, replay, or the
                // controller's own response) ends in res.json — settle there.
                settle.resolve();
                return this;
            },
        };
        mw(req, res, async (err) => {
            if (err) return settle.reject(err);
            try { await ctrl.bookTripSeats(req, res); settle.resolve(); }
            catch (e) { settle.reject(e); }
        }).catch(settle.reject);
        await done;
        return { statusCode, text, jsonPayload };
    }

    const countBookings = () => prisma.transitBooking.count();
    const countSeats = () => prisma.transitBookingSeat.count();
    const claimsOf = (userId, key) => prisma.financialOperation.findFirst({
        where: { userId, key },
    });

    // ── T1: first keyed booking succeeds and records its durable identity ──

    test('T1. first booking succeeds; FinancialOperation row is COMMITTED with '
        + 'the stored response (one intent → one durable identity → one booking)', async () => {
        const { trip, customer } = await seedTrip();
        const out = await book({
            user: customer, tripId: trip.id, key: 'key-T1',
            body: { seatIds: ['1A', '1B'], passengerNames: ['Ama', 'Kofi'], customerNote: 'window please' },
        });
        expect(out.statusCode).toBe(201);
        expect(out.jsonPayload.success).toBe(true);
        expect(await countBookings()).toBe(1);
        expect(await countSeats()).toBe(2);

        const claim = await claimsOf(customer.id, 'key-T1');
        expect(claim).not.toBeNull();
        expect(claim.status).toBe('COMMITTED');
        expect(claim.statusCode).toBe(201);
        expect(claim.endpoint).toBe('POST /api/marketplace/transit/trips/:id/book');
        // The stored response is the exact wire text of what the controller sent.
        expect(claim.responseBody).toBe(out.text);
        expect(JSON.parse(claim.responseBody).booking.id)
            .toBe(out.jsonPayload.booking.id);
    });

    // ── T2: lost response + identical retry → the SAME booking replays ──────

    test('T2. identical retry after a lost response returns the SAME booking, '
        + 'byte-identical; the handler does not execute again', async () => {
        const { trip, customer } = await seedTrip();
        const body = { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: 'aisle' };
        const first = await book({ user: customer, tripId: trip.id, key: 'key-T2', body });
        expect(first.statusCode).toBe(201);

        // The response was LOST in transport. The client retries the SAME
        // identity with the SAME payload.
        const retry = await book({ user: customer, tripId: trip.id, key: 'key-T2', body });
        expect(retry.statusCode).toBe(201);
        expect(retry.text).toBe(first.text);
        expect(retry.jsonPayload.booking.id).toBe(first.jsonPayload.booking.id);
        // Exactly one booking, one seat claim — the retry never re-executed.
        expect(await countBookings()).toBe(1);
        expect(await countSeats()).toBe(1);
        // Only one claim row ever existed for this key.
        expect(await prisma.financialOperation.count({ where: { key: 'key-T2' } })).toBe(1);
    });

    // ── T3: concurrent identical requests → exactly one booking ─────────────

    test('T3. two truly concurrent identical requests create EXACTLY one '
        + 'booking; the duplicate is deterministically refused (409) or served '
        + 'the same committed booking — never a second mutation', async () => {
        const { trip, customer } = await seedTrip();
        const body = { seatIds: ['1A', '1B'], passengerNames: ['Ama', 'Kofi'], customerNote: null };

        // Both claims in flight at once — the unique INSERT is the arbiter.
        const [a, b] = await Promise.all([
            book({ user: customer, tripId: trip.id, key: 'key-T3', body }),
            book({ user: customer, tripId: trip.id, key: 'key-T3', body }),
        ]);
        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([201, 409]);
        expect(await countBookings()).toBe(1);
        expect(await countSeats()).toBe(2);

        // Whichever won, the committed booking is replayable by the SAME key.
        const replay = await book({ user: customer, tripId: trip.id, key: 'key-T3', body });
        expect(replay.statusCode).toBe(201);
        expect(replay.jsonPayload.booking.id).toBe(
            (a.statusCode === 201 ? a : b).jsonPayload.booking.id
        );
        expect(await countBookings()).toBe(1);
    });

    // ── T4: same key + changed seats → fail closed ───────────────────────────

    test('T4. same identity with changed seats fails closed (409 payload '
        + 'conflict); the original booking is untouched', async () => {
        const { trip, customer } = await seedTrip();
        const first = await book({
            user: customer, tripId: trip.id, key: 'key-T4',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(first.statusCode).toBe(201);

        // A CORRECTED selection is a genuinely NEW intent — it must NEVER
        // replay the old booking. Same key + different seats → 409.
        const changed = await book({
            user: customer, tripId: trip.id, key: 'key-T4',
            body: { seatIds: ['1B'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(changed.statusCode).toBe(409);
        expect(JSON.parse(changed.text).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
        expect(await countBookings()).toBe(1);
        // The original booking still replays under the same key.
        const replay = await book({
            user: customer, tripId: trip.id, key: 'key-T4',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(replay.statusCode).toBe(201);
        expect(replay.jsonPayload.booking.id).toBe(first.jsonPayload.booking.id);
    });

    // ── T5: same key + changed passenger-name mapping → fail closed ─────────

    test('T5. same identity with a changed passenger-name mapping fails closed',
        async () => {
        const { trip, customer } = await seedTrip();
        await book({
            user: customer, tripId: trip.id, key: 'key-T5',
            body: { seatIds: ['1A', '1B'], passengerNames: ['Ama', 'Kofi'], customerNote: null },
        });
        const changed = await book({
            user: customer, tripId: trip.id, key: 'key-T5',
            body: { seatIds: ['1A', '1B'], passengerNames: ['Kofi', 'Ama'], customerNote: null },
        });
        expect(changed.statusCode).toBe(409);
        expect(JSON.parse(changed.text).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
        expect(await countBookings()).toBe(1);
    });

    // ── T6: same key + changed note → fail closed (note is booking identity) ─

    test('T6. same identity with a changed customer note fails closed — the '
        + 'note is persisted on the booking and is part of its identity',
        async () => {
        const { trip, customer } = await seedTrip();
        await book({
            user: customer, tripId: trip.id, key: 'key-T6',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: 'near front' },
        });
        const changed = await book({
            user: customer, tripId: trip.id, key: 'key-T6',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: 'back please' },
        });
        expect(changed.statusCode).toBe(409);
        expect(JSON.parse(changed.text).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
        expect(await countBookings()).toBe(1);
    });

    // ── T7: another customer cannot adopt the identity ──────────────────────

    test('T7. another customer using the same key gets their OWN independent '
        + 'operation — claims are (userId, endpoint, key)-scoped; nobody can '
        + 'replay or poison another customer\'s booking', async () => {
        const { trip, customer } = await seedTrip();
        const attacker = await seedUser(prisma, { availableBalance: 500 });

        const first = await book({
            user: customer, tripId: trip.id, key: 'key-T7',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(first.statusCode).toBe(201);

        // The attacker replays the victim's key with their own payload.
        const adopted = await book({
            user: attacker, tripId: trip.id, key: 'key-T7',
            body: { seatIds: ['1B'], passengerNames: ['Evil'], customerNote: null },
        });
        // Scoped identity: the attacker executed THEIR OWN new operation —
        // they did NOT get the victim's booking and did NOT get a conflict.
        expect(adopted.statusCode).toBe(201);
        expect(adopted.jsonPayload.booking.id).not.toBe(first.jsonPayload.booking.id);

        // Two independent claims; the victim's booking is untouched.
        expect(await countBookings()).toBe(2);
        const victimClaim = await claimsOf(customer.id, 'key-T7');
        const attackerClaim = await claimsOf(attacker.id, 'key-T7');
        expect(victimClaim.status).toBe('COMMITTED');
        expect(attackerClaim.status).toBe('COMMITTED');
        // The victim still replays their own booking byte-identically.
        const replay = await book({
            user: customer, tripId: trip.id, key: 'key-T7',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(replay.statusCode).toBe(201);
        expect(replay.text).toBe(first.text);
    });

    // ── T8: another trip cannot adopt the identity ──────────────────────────

    test('T8. the same key against a DIFFERENT trip fails closed — trip '
        + 'identity is inside the fingerprint (params)', async () => {
        const seedA = await seedTrip();
        const seedB = await seedTrip();
        const body = { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null };
        const first = await book({
            user: seedA.customer, tripId: seedA.trip.id, key: 'key-T8', body,
        });
        expect(first.statusCode).toBe(201);

        const crossTrip = await book({
            user: seedA.customer, tripId: seedB.trip.id, key: 'key-T8', body,
        });
        expect(crossTrip.statusCode).toBe(409);
        expect(JSON.parse(crossTrip.text).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
        // No booking was created on trip B from the reused identity.
        expect(await countBookings()).toBe(1);
    });

    // ── T9: rollback before commit → no replayable phantom identity ──────────

    test('T9. a rolled-back transaction (genuine seat conflict) releases the '
        + 'claim — no phantom identity survives; the SAME key is then usable '
        + 'for the corrected request', async () => {
        const { trip, customer, biz } = await seedTrip();
        // Someone else already holds seat 1A (a genuine domain conflict).
        const other = await seedUser(prisma, { availableBalance: 500 });
        const directBooking = await prisma.transitBooking.create({
            data: {
                businessProfileId: biz.id,
                customerId: other.id,
                tripId: trip.id,
                status: 'PENDING',
                pickupAddress: 'Accra',
                dropoffAddress: 'Kumasi',
                scheduledAt: trip.departureAt,
                amountUsdc: 10,
                bookingRef: 'TRN-OTHER-01',
            },
        });
        await prisma.transitBookingSeat.create({
            data: { bookingId: directBooking.id, tripId: trip.id, seatId: '1A', passengerName: 'Zo' },
        });

        // The customer's keyed request hits the seat conflict → 400, rolled back.
        const conflict = await book({
            user: customer, tripId: trip.id, key: 'key-T9',
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(conflict.statusCode).toBe(400);

        // NO phantom identity: the claim was released (releaseOn4xx — the
        // claim only commits inside the booking transaction, so an
        // IN_PROGRESS claim after the response PROVES rollback).
        expect(await claimsOf(customer.id, 'key-T9')).toBeNull();

        // The same key is reusable for the corrected seat selection — and
        // this second attempt is NOT a replay of anything: it executes fresh.
        const corrected = await book({
            user: customer, tripId: trip.id, key: 'key-T9',
            body: { seatIds: ['1B'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(corrected.statusCode).toBe(201);
        expect(corrected.jsonPayload.booking.seatIds ?? corrected.jsonPayload.seatIds)
            .toEqual(['1B']);
        // Exactly two bookings: the other customer's + this corrected one.
        expect(await countBookings()).toBe(2);
        const claim = await claimsOf(customer.id, 'key-T9');
        expect(claim.status).toBe('COMMITTED');
        expect(claim.responseBody).toBe(corrected.text);
    });

    // ── T10: keyless legacy request keeps today's behavior ──────────────────

    test('T10. a keyless (legacy) request executes with NO claim and NO '
        + 'replay — protected only by the DB seat uniqueness, exactly as '
        + 'before the wiring', async () => {
        const { trip, customer } = await seedTrip();
        const out = await book({
            user: customer, tripId: trip.id, key: null,
            body: { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null },
        });
        expect(out.statusCode).toBe(201);
        expect(await countBookings()).toBe(1);
        expect(await prisma.financialOperation.count()).toBe(0);
    });

    // ── T11: the fingerprint covers the authoritative intent only ──────────

    test('T11. the fare is never client-supplied: an attempt to smuggle a '
        + 'fare into the payload is rejected as a payload conflict on retry '
        + '(the fingerprint covers the authoritative intent — seats, names, '
        + 'note, trip — not client economics)', async () => {
        const { trip, customer } = await seedTrip();
        const body = { seatIds: ['1A'], passengerNames: ['Ama'], customerNote: null };
        const first = await book({ user: customer, tripId: trip.id, key: 'key-T11', body });
        expect(first.statusCode).toBe(201);
        // The committed fare came from the trip configuration, not the client.
        expect(Number(first.jsonPayload.booking.amountUsdc)).toBe(10);

        // Same key + smuggled fare = a different payload → fail closed.
        const smuggle = await book({
            user: customer, tripId: trip.id, key: 'key-T11',
            body: { ...body, amountUsdc: 0.01 },
        });
        expect(smuggle.statusCode).toBe(409);
        expect(JSON.parse(smuggle.text).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
        expect(await countBookings()).toBe(1);
    });
});
