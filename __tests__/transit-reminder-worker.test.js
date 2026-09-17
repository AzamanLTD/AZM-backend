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
            expect(n.body).toContain('Seat(s): 1A, 2B.');
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
                seats: '1A, 2B',
            });
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
