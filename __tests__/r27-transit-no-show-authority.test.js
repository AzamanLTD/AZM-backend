// __tests__/r27-transit-no-show-authority.test.js
// =============================================================================
// r27 / P0-B — REAL PostgreSQL proofs that NO_SHOW on a transit booking is
// business/operator/worker-authoritative and that a customer can never remove
// a CONFIRMED booking from the no-show worker's penalty candidate set.
//
// Exercises controllers/transitController.updateBookingStatus against the real
// database (real rows, real escrows funded through the canonical path, real
// balance convergence) — not controller mocks.
//
// Proves:
//   B1. customer CONFIRMED -> NO_SHOW rejected (403); booking stays CONFIRMED
//   B2. customer CONFIRMED -> CANCELLED still follows the legitimate
//       cancellation contract
//   B3. business owner CONFIRMED -> NO_SHOW with funded escrow + configured
//       penalty executes the canonical penalty/refund split (same economics
//       as the worker), never a bare status flip
//   B4. business owner NO_SHOW without a funded/claimable escrow or without
//       penalty config mirrors the worker's exact behavior
//   B5. after a rejected customer attempt, the no-show worker still finds and
//       processes the booking normally (penalty economics intact)
//   B6. unauthorized third-party user and cross-business owner fail closed
//   B7. customer PENDING -> NO_SHOW also rejected (403), transition table intact
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r27-transit-no-show-authority] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r27 P0-B: transit NO_SHOW is business-authoritative (real PostgreSQL)', () => {
    let prisma;
    let ctrl;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ctrl = require('../controllers/transitController');
    });
    afterAll(async () => { await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "TransactionHistory", "SystemProfitFees", "Ticket", "SmartEscrow", "User", "BusinessProfile", "TransitVehicle", "TransitTrip", "TransitBooking", "TransitBookingSeat", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    function mockReqRes({ user, params = {}, body = {} } = {}) {
        const req = {
            user, params, body,
            app: { get: (key) => (key === 'prisma' ? prisma : undefined) },
        };
        const res = {
            statusCode: 200,
            payload: undefined,
            status(c) { this.statusCode = c; return this; },
            json(p) { this.payload = p; return this; },
        };
        return { req, res };
    }

    async function seedContext() {
        const { biz, owner } = await seedBusiness(prisma);
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'VAN', capacity: 12, licensePlate: `GT-B-${Date.now()}` },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id, vehicleId: vehicle.id,
                routeName: 'Tema Loop', origin: 'Tema', destination: 'Accra',
                departureAt: new Date(Date.now() + 3600_000), fareUsdc: 15, availableSeats: 12,
            },
        });
        return { biz, owner, vehicle, trip };
    }

    let _seq = 0;
    async function seedBooking(ctx, overrides = {}) {
        const customer = await seedUser(prisma, { availableBalance: 500 });
        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: ctx.biz.id, customerId: customer.id, tripId: ctx.trip.id,
                pickupAddress: 'A', dropoffAddress: 'B',
                amountUsdc: overrides.amountUsdc ?? 40,
                status: overrides.status ?? 'CONFIRMED',
                scheduledAt: overrides.scheduledAt ?? new Date(Date.now() + 1800_000),
                bookingRef: `TRN-NS-${Date.now()}-${++_seq}`,
                ...(overrides.penaltyPct != null ? { noShowPenaltyPct: overrides.penaltyPct } : {}),
            },
        });
        return { customer, booking };
    }

    async function fundEscrow(ctx, booking, customer, amount) {
        const { createBookingEscrow, fundBookingEscrow } = require('../services/bookingEscrowService');
        const { escrow } = await createBookingEscrow(prisma, {
            bookingType: 'TRANSIT', bookingId: booking.id,
            payerId: customer.id, payeeId: ctx.owner.id,
            amountUsdc: amount, businessProfileId: ctx.biz.id,
        });
        await fundBookingEscrow(prisma, {
            escrowId: escrow.id, payerId: customer.id, bookingType: 'TRANSIT', bookingId: booking.id,
        });
        return escrow.id;
    }

    const snap = async (userId) => {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: { availableBalance: true, escrowLockedBalance: true },
        });
        return { available: Number(u.availableBalance), locked: Number(u.escrowLockedBalance) };
    };

    test('B1. customer CONFIRMED -> NO_SHOW is rejected 403 and the booking remains CONFIRMED', async () => {
        const ctx = await seedContext();
        const { customer, booking } = await seedBooking(ctx);
        await fundEscrow(ctx, booking, customer, 40);

        const { req, res } = mockReqRes({ user: { id: customer.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.payload.success).toBe(false);
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CONFIRMED');
        // No money moved either.
        expect((await snap(customer.id)).locked).toBeCloseTo(40, 6);
    });

    test('B2. customer CONFIRMED -> CANCELLED still follows the legitimate cancellation contract', async () => {
        const ctx = await seedContext();
        const { customer, booking } = await seedBooking(ctx);

        const { req, res } = mockReqRes({ user: { id: customer.id }, params: { id: booking.id }, body: { status: 'CANCELLED' } });
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CANCELLED');
    });

    test('B3. business owner NO_SHOW with funded escrow + configured penalty executes the canonical split (never a bare flip)', async () => {
        const ctx = await seedContext();
        const { customer, booking } = await seedBooking(ctx, { penaltyPct: 0.25 });
        const escrowId = await fundEscrow(ctx, booking, customer, 40);

        const { req, res } = mockReqRes({ user: { id: ctx.owner.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);
        expect(res.payload.booking.status).toBe('NO_SHOW');

        // Canonical economics: escrow RELEASED, 25% penalty (10) to the
        // business, 75% (30) back to the customer, balances exact.
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('RELEASED');
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(0, 6);
        expect(payer.available).toBeCloseTo(500 - 40.2 + 30, 6);
        const payee = await snap(ctx.owner.id);
        expect(payee.available).toBeCloseTo(1000 + 10, 6);

        const bookingAfter = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(bookingAfter.status).toBe('NO_SHOW');
        expect(Number(bookingAfter.penaltyAmountUsdc)).toBeCloseTo(10, 6);
        expect(bookingAfter.penaltyChargedAt).not.toBeNull();
    });

    test('B4a. business owner NO_SHOW with no escrow mirrors the worker (plain status flip)', async () => {
        const ctx = await seedContext();
        const { customer, booking } = await seedBooking(ctx);

        const { req, res } = mockReqRes({ user: { id: ctx.owner.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.booking.status).toBe('NO_SHOW');
    });

    test('B4b. business owner NO_SHOW with funded escrow but no penalty config mirrors the worker exactly (plain flip, escrow untouched — the worker\'s own no-penalty contract)', async () => {
        const ctx = await seedContext();
        const { customer, booking } = await seedBooking(ctx); // no penalty config
        const escrowId = await fundEscrow(ctx, booking, customer, 40);

        const { req, res } = mockReqRes({ user: { id: ctx.owner.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.booking.status).toBe('NO_SHOW');
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('FUNDED'); // same as the worker's no-penalty branch
        expect((await snap(customer.id)).locked).toBeCloseTo(40, 6);
    });

    test('B5. after a rejected customer NO_SHOW attempt, the worker still finds the booking and executes the penalty economics', async () => {
        const ctx = await seedContext();
        // Past the 30-minute grace window, still CONFIRMED, escrow funded.
        const { customer, booking } = await seedBooking(ctx, {
            penaltyPct: 0.25,
            scheduledAt: new Date(Date.now() - 60 * 60 * 1000),
        });
        await fundEscrow(ctx, booking, customer, 40);

        // Customer tries to dodge the penalty first — rejected, no mutation.
        const rejected = mockReqRes({ user: { id: customer.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(rejected.req, rejected.res);
        expect(rejected.res.statusCode).toBe(403);

        // The worker sweep still sees the booking as CONFIRMED and processes it.
        const { sweepNoShowTransitBookings } = require('../workers/reservationNoShowWorker');
        const results = await sweepNoShowTransitBookings(prisma);

        expect(results.processed).toBe(1);
        expect(results.penalized).toBe(1);
        expect(results.errors).toBe(0);

        const bookingAfter = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(bookingAfter.status).toBe('NO_SHOW');
        expect(Number(bookingAfter.penaltyAmountUsdc)).toBeCloseTo(10, 6);
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(0, 6);
        expect(payer.available).toBeCloseTo(500 - 40.2 + 30, 6);
        const payee = await snap(ctx.owner.id);
        expect(payee.available).toBeCloseTo(1010, 6);
    });

    test('B6. an unauthorized third party and a cross-business owner both fail closed', async () => {
        const ctx = await seedContext();
        const { booking } = await seedBooking(ctx);
        const stranger = await seedUser(prisma);
        const { biz: otherBiz, owner: otherOwner } = await seedBusiness(prisma);

        const asStranger = mockReqRes({ user: { id: stranger.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(asStranger.req, asStranger.res);
        expect(asStranger.res.statusCode).toBe(403);

        const asOtherOwner = mockReqRes({ user: { id: otherOwner.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(asOtherOwner.req, asOtherOwner.res);
        expect(asOtherOwner.res.statusCode).toBe(403);

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CONFIRMED');
        expect(otherBiz).toBeDefined();
    });

    test('B7. customer PENDING -> NO_SHOW is also rejected; the transition table stays intact', async () => {
        const ctx = await seedContext();
        const { customer, booking } = await seedBooking(ctx, { status: 'PENDING' });

        const { req, res } = mockReqRes({ user: { id: customer.id }, params: { id: booking.id }, body: { status: 'NO_SHOW' } });
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(403);
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('PENDING');
    });
});
