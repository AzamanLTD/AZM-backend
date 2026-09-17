// __tests__/transit-reminder-worker.test.js
// Regression coverage for the transit reminder worker sweep:
//   A. loads a CONFIRMED booking with TransitBookingSeat rows WITHOUT any
//      `seat` relation (TransitBookingSeat has none — the old include could
//      never validate against the real schema)
//   B. the stored seatId values appear verbatim in the notification body and
//      the socket payload
//   C. a Notification row is actually created (the previous create payload
//      used nonexistent `type`/`metadata` columns and an invalid category —
//      this suite pins the fixed shape to the real schema)
//   D. reminderSentAt is stamped, and the sweep reports the booking as sent
//   E. a second sweep does not resend (reminderSentAt gating)
//   F. two CONCURRENT sweeps racing one eligible booking converge to exactly
//      one notification / one claim / one socket emission (the atomic claim
//      at the DB boundary arbitrates — no in-memory mutex)
//   G. if Notification creation fails, the claim rolls back (reminderSentAt
//      stays NULL) and the next sweep retries successfully
// SKIPS unless TEST_DATABASE_URL is set (same convention as the other
// DB-backed suites; CI provides a disposable PostgreSQL instance).

const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[transit-reminder-worker.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Transit reminder worker (sweepTransitReminders)', () => {
    let prisma;
    let sweepTransitReminders;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ sweepTransitReminders } = require('../workers/transitReminderWorker'));
    });

    afterAll(async () => { await prisma.$disconnect(); });

    // Test-harness cleanup (CI shares one disposable database between suites).
    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "BusinessProfile", "TransitVehicle", "TransitTrip", "TransitBooking", "TransitBookingSeat", "Notification" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // Seeds a CONFIRMED booking departing inside the reminder window
    // (60–75 min from `now`) with two seat rows, plus the customer.
    async function seedConfirmedBookingWithSeats() {
        const customer = await seedUser(prisma);
        const { biz } = await seedBusiness(prisma);

        const vehicle = await prisma.transitVehicle.create({
            data: {
                businessProfileId: biz.id,
                type: 'BUS',
                capacity: 40,
                licensePlate: 'GT-REM-26',
            },
        });

        const departureAt = new Date(Date.now() + 67 * 60 * 1000); // 67 min out — inside 60–75 window
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id,
                vehicleId: vehicle.id,
                routeName: 'Accra–Kumasi Express',
                origin: 'Accra',
                destination: 'Kumasi',
                departureAt,
                fareUsdc: 25,
                availableSeats: 38,
            },
        });

        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: biz.id,
                tripId: trip.id,
                vehicleId: vehicle.id,
                customerId: customer.id,
                status: 'CONFIRMED',
                pickupAddress: 'Accra Central Station',
                dropoffAddress: 'Kumasi Terminal',
                amountUsdc: 50,
                bookingRef: `TRN-REM-${Date.now()}`,
            },
        });

        const seatRows = await Promise.all(
            ['1A', '2B'].map((seatId) =>
                prisma.transitBookingSeat.create({
                    data: { bookingId: booking.id, tripId: trip.id, seatId },
                })
            )
        );

        return { customer, trip, booking, seatRows };
    }

    test('sends one reminder with stored seat IDs, persists the notification, and never resends', async () => {
        const { customer, trip, booking } = await seedConfirmedBookingWithSeats();

        // Capture the real-time socket payload the worker emits.
        const emitted = [];
        const originalIo = global._io;
        global._io = {
            to: (room) => ({
                emit: (event, payload) => emitted.push({ room, event, payload }),
            }),
        };
        try {
            // ── First sweep ──────────────────────────────────────────────────
            const first = await sweepTransitReminders(prisma);

            expect(first).toEqual({ processed: 1, sent: 1, errors: 0 });

            // Notification persisted with the fixed schema shape.
            const notifications = await prisma.notification.findMany({
                where: { userId: customer.id },
            });
            expect(notifications).toHaveLength(1);
            const n = notifications[0];
            expect(n.title).toBe(`Trip departing soon: ${trip.routeName}`);
            expect(n.body).toContain('Kumasi');
            // Stored seat identifiers appear verbatim in the reminder body.
            // (Seat row order is not deterministic — Prisma returns them
            // unordered — so compare the parsed list as a set.)
            const seatMatch = n.body.match(/Seat\(s\): ([^.]+)\./);
            expect(seatMatch).not.toBeNull();
            expect(seatMatch[1].split(', ').sort()).toEqual(['1A', '2B'].sort());
            expect(n.category).toBe('GENERAL');
            expect(n.actionPayload).toMatchObject({
                action: 'TRANSIT_REMINDER',
                type: 'TRANSIT_REMINDER',
                bookingId: booking.id,
                tripId: trip.id,
                routeName: trip.routeName,
            });

            // Reminder marked as sent on the booking.
            const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(after.reminderSentAt).toBeInstanceOf(Date);
            expect(after.reminderSentAt).not.toBeNull();

            // Socket payload carries the stored seat IDs to the customer room.
            expect(emitted).toHaveLength(1);
            expect(emitted[0].room).toBe(`user_${customer.id}`);
            expect(emitted[0].event).toBe('transit_reminder');
            expect(emitted[0].payload).toMatchObject({
                bookingId: booking.id,
                routeName: trip.routeName,
                origin: trip.origin,
                destination: trip.destination,
            });
            expect(String(emitted[0].payload.seats).split(', ').sort()).toEqual(['1A', '2B'].sort());
            expect(new Date(emitted[0].payload.departureAt).toISOString()).toBe(trip.departureAt.toISOString());

            // ── Second sweep: reminderSentAt gating must prevent a resend ────
            const second = await sweepTransitReminders(prisma);
            expect(second).toEqual({ processed: 0, sent: 0, errors: 0 });

            const notificationsAfter = await prisma.notification.findMany({
                where: { userId: customer.id },
            });
            expect(notificationsAfter).toHaveLength(1); // no duplicate
            expect(emitted).toHaveLength(1); // no duplicate socket push
        } finally {
            global._io = originalIo;
        }
    });

    // ── Concurrency: two overlapping sweeps, one eligible booking ─────────
    // The claim is a conditional UPDATE ... WHERE reminderSentAt IS NULL inside
    // the same transaction as the notification create, so overlapping sweeps
    // must converge to exactly one delivery. A Proxy around the prisma client
    // gates transitBooking.findMany on a two-party barrier, forcing BOTH
    // sweeps to read the booking as eligible BEFORE either attempts the claim
    // — the classic race window, made deterministic.
    test('two concurrent sweeps converge to exactly one notification, claim, and socket emission', async () => {
        const { customer, trip, booking } = await seedConfirmedBookingWithSeats();

        const emitted = [];
        const originalIo = global._io;
        global._io = {
            to: (room) => ({
                emit: (event, payload) => emitted.push({ room, event, payload }),
            }),
        };
        try {
            let arrivals = 0;
            let releaseBarrier;
            const gate = new Promise((resolve) => { releaseBarrier = resolve; });
            const twoPartyBarrier = async () => {
                arrivals++;
                if (arrivals === 2) { releaseBarrier(); return; }
                await gate; // first sweep waits until the second one arrives
            };

            // Proxy: both sweeps share this client; findMany is held on the
            // barrier so both read eligibility first. Everything else —
            // including $transaction and the interactive tx delegates —
            // passes through untouched to the real DB boundary.
            let findManyCalls = 0;
            const racingClient = new Proxy(prisma, {
                get(target, prop, receiver) {
                    if (prop !== 'transitBooking') return Reflect.get(target, prop, receiver);
                    return new Proxy(target.transitBooking, {
                        get(t2, p2, r2) {
                            if (p2 !== 'findMany') return Reflect.get(t2, p2, r2);
                            return async (...args) => {
                                findManyCalls++;
                                await twoPartyBarrier();
                                return t2.findMany(...args);
                            };
                        }
                    });
                }
            });

            const [sweepA, sweepB] = await Promise.all([
                sweepTransitReminders(racingClient),
                sweepTransitReminders(racingClient),
            ]);

            // Both sweeps saw the booking as eligible before either claimed.
            expect(findManyCalls).toBe(2);

            // Exactly one successful claim across both sweeps — the loser is
            // not an error.
            expect(sweepA.sent + sweepB.sent).toBe(1);
            expect(sweepA.errors + sweepB.errors).toBe(0);
            expect(sweepA.processed + sweepB.processed).toBe(2);

            // Exactly one notification row — no duplicate.
            const notifications = await prisma.notification.findMany({
                where: { userId: customer.id },
            });
            expect(notifications).toHaveLength(1);
            expect(notifications[0].actionPayload).toMatchObject({
                bookingId: booking.id,
                tripId: trip.id,
            });

            // Exactly one successful reminder claim, durably stamped.
            const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(after.reminderSentAt).toBeInstanceOf(Date);
            expect(after.reminderSentAt).not.toBeNull();

            // Exactly one socket emission — only after commit.
            expect(emitted).toHaveLength(1);
            expect(emitted[0].room).toBe(`user_${customer.id}`);
            expect(emitted[0].event).toBe('transit_reminder');
            expect(emitted[0].payload).toMatchObject({ bookingId: booking.id });

            // A later sweep finds nothing left to do.
            const third = await sweepTransitReminders(prisma);
            expect(third).toEqual({ processed: 0, sent: 0, errors: 0 });
            expect((await prisma.notification.findMany({ where: { userId: customer.id } })).length).toBe(1);
            expect(emitted).toHaveLength(1);
        } finally {
            global._io = originalIo;
        }
    });

    // ── Failure path: notification creation fails inside the claim tx ──────
    // The claim must roll back WITH the notification failure — a booking is
    // never permanently marked reminded without its notification — and the
    // next sweep retries and succeeds normally.
    test('a notification failure rolls the claim back and the next sweep retries cleanly', async () => {
        const { customer, booking } = await seedConfirmedBookingWithSeats();

        const emitted = [];
        const originalIo = global._io;
        global._io = {
            to: (room) => ({
                emit: (event, payload) => emitted.push({ room, event, payload }),
            }),
        };
        try {
            // Force notification INSERTs to fail at the DB boundary with an
            // unsatisfiable CHECK constraint (real PostgreSQL, not a mock).
            await prisma.$executeRawUnsafe(
                'ALTER TABLE "Notification" ADD CONSTRAINT "transit_rem_test_force_fail" CHECK (false)'
            );

            const failed = await sweepTransitReminders(prisma);
            expect(failed).toEqual({ processed: 1, sent: 0, errors: 1 });

            // Claim rolled back: booking still eligible, nothing delivered.
            const rolledBack = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(rolledBack.reminderSentAt).toBeNull();
            expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(0);
            expect(emitted).toHaveLength(0);

            // Lift the forced failure and retry — normal delivery resumes.
            await prisma.$executeRawUnsafe(
                'ALTER TABLE "Notification" DROP CONSTRAINT "transit_rem_test_force_fail"'
            );
            const retried = await sweepTransitReminders(prisma);
            expect(retried).toEqual({ processed: 1, sent: 1, errors: 0 });

            const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
            expect(after.reminderSentAt).toBeInstanceOf(Date);
            expect(await prisma.notification.count({ where: { userId: customer.id } })).toBe(1);
            expect(emitted).toHaveLength(1);
        } finally {
            // Safety: never leave the constraint behind, even on assertion
            // failure inside the try block.
            await prisma.$executeRawUnsafe(
                'ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "transit_rem_test_force_fail"'
            ).catch(() => {});
            global._io = originalIo;
        }
    });

    test('a booking outside the reminder window is not touched', async () => {
        const { booking } = await seedConfirmedBookingWithSeats();
        // Push departure outside the 60–75 min window (e.g. 3 hours out).
        await prisma.transitTrip.update({
            where: { id: booking.tripId },
            data: { departureAt: new Date(Date.now() + 3 * 60 * 60 * 1000) },
        });

        const result = await sweepTransitReminders(prisma);
        expect(result).toEqual({ processed: 0, sent: 0, errors: 0 });

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.reminderSentAt).toBeNull();
    });
});
