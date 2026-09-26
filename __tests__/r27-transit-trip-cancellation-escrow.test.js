// __tests__/r27-transit-trip-cancellation-escrow.test.js
// =============================================================================
// r27 / P0-A — REAL PostgreSQL proofs that business transit trip cancellation
// resolves every funded customer escrow through the canonical refund authority
// (services/bookingEscrowService.refundBookingEscrow economic identity).
//
// These are NOT controller mocks: every case seeds real rows, funds real
// escrows through the canonical createBookingEscrow + fundBookingEscrow path,
// and asserts escrow/balance/ledger convergence in the actual database.
//
// Proves:
//   A1. funded booking + trip cancellation => booking CANCELLED + escrow
//       REFUNDED + payer locked balance restored + ledger + TransactionHistory
//   A2. multiple funded bookings => every eligible booking refunded exactly once
//   A3. pending booking without escrow => CANCELLED_NO_ESCROW, no money motion
//   A4. concurrent cancellation attempts => exactly-once economics,
//       deterministic convergence
//   A5. injected refund failure => no false success, booking rolls back to its
//       prior state, trip stays active; retry after the fault resolves it
//   A6. retry after full success => zero economic mutations
//   A7. already-finalized (REFUNDED) escrow => booking cancelled, no second
//       economic mutation; DISPUTED escrow => left in dispute custody,
//       reported distinctly, never claimed as refunded
//   A8. legacy stranding recovery: booking already CANCELLED with a still
//       FUNDED escrow (exactly what the old route produced) is refunded
//   A9. tenant mismatch => notFound, zero rows touched, zero money moved
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r27-transit-trip-cancellation-escrow] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r27 P0-A: transit trip cancellation resolves funded escrows (real PostgreSQL)', () => {
    let prisma;
    let cancelTripWithRefunds;
    let bookingEscrowService;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ cancelTripWithRefunds } = require('../services/transitTripCancellationService'));
        bookingEscrowService = require('../services/bookingEscrowService');
    });
    afterAll(async () => { await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "TransactionHistory", "SystemProfitFees", "Ticket", "SmartEscrow", "User", "BusinessProfile", "TransitVehicle", "TransitTrip", "TransitBooking", "TransitBookingSeat", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    async function seedBusinessWithTrip(ownerOverrides = {}) {
        const { biz, owner } = await seedBusiness(prisma, ownerOverrides);
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'BUS', capacity: 30, licensePlate: `GT-${Date.now()}` },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id, vehicleId: vehicle.id,
                routeName: 'Accra-Kumasi Express', origin: 'Accra', destination: 'Kumasi',
                departureAt: new Date(Date.now() + 3600_000), fareUsdc: 25, availableSeats: 30,
            },
        });
        return { biz, owner, vehicle, trip };
    }

    let _bookingSeq = 0;
    async function seedFundedBooking(ctx, overrides = {}) {
        const customer = await seedUser(prisma, { availableBalance: 500 });
        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: ctx.biz.id, customerId: customer.id,
                tripId: ctx.trip.id,
                pickupAddress: 'Accra Central', dropoffAddress: 'Kumasi Station',
                amountUsdc: overrides.amountUsdc ?? 40,
                status: overrides.status ?? 'CONFIRMED',
                scheduledAt: new Date(Date.now() + 1800_000),
                bookingRef: `TRN-27-${Date.now()}-${++_bookingSeq}`,
            },
        });
        const { escrow } = await bookingEscrowService.createBookingEscrow(prisma, {
            bookingType: 'TRANSIT', bookingId: booking.id,
            payerId: customer.id, payeeId: ctx.owner.id,
            amountUsdc: overrides.amountUsdc ?? 40, businessProfileId: ctx.biz.id,
        });
        await bookingEscrowService.fundBookingEscrow(prisma, {
            escrowId: escrow.id, payerId: customer.id,
            bookingType: 'TRANSIT', bookingId: booking.id,
        });
        return { customer, booking, escrowId: escrow.id };
    }

    const payerSnapshot = async (userId) => {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: { availableBalance: true, escrowLockedBalance: true },
        });
        return {
            available: Number(u.availableBalance),
            locked: Number(u.escrowLockedBalance),
        };
    };
    // The escrow's economic identity: funding posts one ESCROW_FUND, the
    // refund posts one ESCROW_REFUND. Exactly-once means exactly one REFUND
    // posting ever exists per escrow (guarded by the unique idempotencyKey).
    const refundLedgerCount = (escrowId) =>
        prisma.ledgerTransaction.count({
            where: { relatedEntityId: escrowId, entryType: 'ESCROW_REFUND' },
        });
    const allEscrowLedgerCount = (escrowId) =>
        prisma.ledgerTransaction.count({ where: { relatedEntityId: escrowId } });

    // A1 — the headline invariant: cancelled trip => refunded escrow, real balances.
    test('A1. funded booking + trip cancellation => booking CANCELLED, escrow REFUNDED, payer balance restored, ledger + TransactionHistory posted', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedFundedBooking(ctx, { amountUsdc: 40 });

        const before = await payerSnapshot(customer.id);
        expect(before.locked).toBeCloseTo(40, 6);

        const result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        expect(result.notFound).toBeUndefined();
        expect(result.cancelled).toBe(true);
        expect(result.summary.failed).toBe(0);
        expect(result.summary.refunded).toBe(1);

        const bookingAfter = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(bookingAfter.status).toBe('CANCELLED');
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrowAfter.status).toBe('REFUNDED');
        expect(escrowAfter.refundedAt).not.toBeNull();

        const after = await payerSnapshot(customer.id);
        expect(after.locked).toBeCloseTo(0, 6);
        expect(after.available).toBeCloseTo(before.available + 40, 6);

        // Canonical economic identity: exactly one ledger posting for this
        // escrow and exactly one COMPLETED refund history row for the payer.
        expect(await refundLedgerCount(escrowId)).toBe(1);
        const refundHistory = await prisma.transactionHistory.count({
            where: { userId: customer.id, type: 'TICKET_ESCROW_REFUND', status: 'COMPLETED' },
        });
        expect(refundHistory).toBe(1);
    });

    // A2 — every funded booking refunded exactly once.
    test('A2. multiple funded bookings => every eligible booking refunded exactly once, each with its own ledger identity', async () => {
        const ctx = await seedBusinessWithTrip();
        const b1 = await seedFundedBooking(ctx, { amountUsdc: 40 });
        const b2 = await seedFundedBooking(ctx, { amountUsdc: 25 });
        const b3 = await seedFundedBooking(ctx, { amountUsdc: 15 });

        const result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        expect(result.cancelled).toBe(true);
        expect(result.summary.refunded).toBe(3);
        expect(result.summary.failed).toBe(0);

        for (const b of [b1, b2, b3]) {
            const escrow = await prisma.smartEscrow.findUnique({ where: { id: b.escrowId } });
            const snap = await payerSnapshot(b.customer.id);
            expect(escrow.status).toBe('REFUNDED');
            expect(snap.locked).toBeCloseTo(0, 6);
            expect(snap.available).toBeCloseTo(500 - (Number(escrow.amountUsdc) + Number(escrow.feeUsdc)) + Number(escrow.amountUsdc), 6);
            expect(await refundLedgerCount(b.escrowId)).toBe(1);
        }
        const bookings = await prisma.transitBooking.findMany({ where: { tripId: ctx.trip.id } });
        expect(bookings.every((b) => b.status === 'CANCELLED')).toBe(true);
    });

    // A3 — booking without escrow still cancels cleanly, no money motion.
    test('A3. pending booking with no escrow => CANCELLED_NO_ESCROW, zero balance mutation', async () => {
        const ctx = await seedBusinessWithTrip();
        const customer = await seedUser(prisma, { availableBalance: 100 });
        await prisma.transitBooking.create({
            data: {
                businessProfileId: ctx.biz.id, customerId: customer.id, tripId: ctx.trip.id,
                pickupAddress: 'A', dropoffAddress: 'B', amountUsdc: 20,
                status: 'PENDING', bookingRef: `TRN-27-P-${Date.now()}`,
            },
        });

        const result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        expect(result.cancelled).toBe(true);
        expect(result.summary.cancelledWithoutEscrow).toBe(1);
        expect(result.summary.refunded).toBe(0);
        const snap = await payerSnapshot(customer.id);
        expect(snap.available).toBeCloseTo(100, 6);
        expect(snap.locked).toBeCloseTo(0, 6);
    });

    // A4 — racing cancellations converge with exactly-once economics.
    test('A4. concurrent cancellation attempts => one economic outcome per booking, no double refund, trip converges to CANCELLED', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, escrowId } = await seedFundedBooking(ctx, { amountUsdc: 40 });

        const [r1, r2] = await Promise.all([
            cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id }),
            cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id }),
        ]);

        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('REFUNDED');
        expect(await refundLedgerCount(escrowId)).toBe(1);

        const snap = await payerSnapshot(customer.id);
        expect(snap.locked).toBeCloseTo(0, 6);
        expect(snap.available).toBeCloseTo(500 - 40.2 + 40, 6); // 500 funded -> principal back exactly once

        for (const r of [r1, r2]) {
            expect(r.cancelled).toBe(true);
            const refunded = r.bookings.filter((b) => b.outcome === 'REFUNDED');
            const already = r.bookings.filter((b) => b.outcome === 'ALREADY_RESOLVED' || b.outcome === 'ESCROW_ALREADY_FINALIZED');
            expect(refunded.length + already.length).toBe(1); // one booking, one resolution total across the race
            expect(r.summary.failed).toBe(0);
        }
        // Sum of real refunds across both racing calls is exactly one.
        expect(r1.summary.refunded + r2.summary.refunded).toBe(1);
    });

    // A5 — injected refund failure: explicit failure, honest rollback, trip not cancelled, retry recovers.
    test('A5. injected escrow-refund failure => FAILED outcome, booking stays CONFIRMED, trip stays SCHEDULED; retry after fault clears resolves it', async () => {
        const ctx = await seedBusinessWithTrip();
        const target = await seedFundedBooking(ctx, { amountUsdc: 40 });
        const healthy = await seedFundedBooking(ctx, { amountUsdc: 25 });

        // Inject a deterministic ledger failure into the refund path.
        const realPost = require('../services/ledgerService').post;
        let failNext = true;
        require('../services/ledgerService').post = jest.fn(async (tx, entry) => {
            if (failNext && entry.idempotencyKey.includes('refund')) {
                failNext = false;
                throw new Error('INJECTED_LEDGER_FAILURE');
            }
            return realPost(tx, entry);
        });

        let result;
        try {
            result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });
        } finally {
            require('../services/ledgerService').post = realPost;
        }

        // Explicit partial failure — no false success.
        expect(result.cancelled).toBe(false);
        expect(result.summary.failed).toBe(1);
        expect(result.summary.refunded + result.summary.cancelledWithoutEscrow + result.summary.failed).toBe(2);

        const failedOutcome = result.bookings.find((b) => b.outcome === 'FAILED');
        expect(failedOutcome).toBeDefined();
        expect(failedOutcome.error).toContain('INJECTED_LEDGER_FAILURE');

        // The failed booking's whole pair rolled back: still active, escrow still FUNDED, money still locked.
        const failedBooking = failedOutcome.bookingId === target.booking.id ? target : healthy;
        const failedEscrow = await prisma.smartEscrow.findUnique({ where: { id: failedBooking.escrowId } });
        const failedRow = await prisma.transitBooking.findUnique({ where: { id: failedBooking.booking.id } });
        expect(failedRow.status).toBe('CONFIRMED');
        expect(failedEscrow.status).toBe('FUNDED');
        const failedSnap = await payerSnapshot(failedBooking.customer.id);
        expect(failedSnap.locked).toBeCloseTo(40, 6); // or 25 — assert against the actual failed booking amount
        expect(failedSnap.locked).toBeCloseTo(Number(failedEscrow.amountUsdc), 6);

        // The trip honestly stayed active (recoverable).
        const tripAfter = await prisma.transitTrip.findUnique({ where: { id: ctx.trip.id } });
        expect(tripAfter.status).toBe('SCHEDULED');

        // Retry with the fault cleared: the previously failed booking resolves, trip converges.
        const retry = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });
        expect(retry.cancelled).toBe(true);
        expect(retry.summary.failed).toBe(0);
        expect(retry.summary.refunded).toBe(1);
        // The booking that resolved in the first pass (CANCELLED + REFUNDED
        // escrow) correctly drops out of the retry's candidate set entirely —
        // exactly-once, no re-processing, no duplicate refund.
        expect(retry.bookings).toHaveLength(1);
        expect(retry.bookings[0].bookingId).toBe(failedBooking.booking.id);

        const escrowFinal = await prisma.smartEscrow.findUnique({ where: { id: failedBooking.escrowId } });
        expect(escrowFinal.status).toBe('REFUNDED');
        expect(await refundLedgerCount(failedBooking.escrowId)).toBe(1);
    });

    // A6 — retry after full success mutates nothing.
    test('A6. retry after successful cancellation => zero economic mutations, zero outcome rows', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, escrowId } = await seedFundedBooking(ctx, { amountUsdc: 40 });
        await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        const before = await payerSnapshot(customer.id);
        const ledgerBefore = await allEscrowLedgerCount(escrowId);

        const retry = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        expect(retry.cancelled).toBe(true);
        expect(retry.bookings).toHaveLength(0);
        expect(retry.summary.failed).toBe(0);

        const after = await payerSnapshot(customer.id);
        expect(after).toEqual(before);
        expect(await allEscrowLedgerCount(escrowId)).toBe(ledgerBefore);
    });

    // A7 — finalized and disputed escrows never receive a second economic mutation.
    test('A7. REFUNDED-escrow booking cancels with ESCROW_ALREADY_FINALIZED (no second mutation); DISPUTED escrow stays in dispute custody', async () => {
        const ctx = await seedBusinessWithTrip();
        const resolved = await seedFundedBooking(ctx, { amountUsdc: 40 });
        // Out-of-band canonical resolution (e.g. prior direct refund):
        await bookingEscrowService.refundBookingEscrow(prisma, { escrowId: resolved.escrowId });
        const resolvedSnap = await payerSnapshot(resolved.customer.id);
        const resolvedLedger = await allEscrowLedgerCount(resolved.escrowId);

        const disputed = await seedFundedBooking(ctx, { amountUsdc: 25 });
        // Move the escrow into DISPUTED custody the way raiseDispute does.
        await prisma.smartEscrow.update({
            where: { id: disputed.escrowId },
            data: { status: 'DISPUTED' },
        });
        await prisma.user.update({
            where: { id: disputed.customer.id },
            data: { escrowLockedBalance: { decrement: 25 }, disputeEscrowBalance: { increment: 25 } },
        });
        const disputedSnap = await payerSnapshot(disputed.customer.id);

        const result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        expect(result.cancelled).toBe(true);
        expect(result.summary.failed).toBe(0);
        expect(result.summary.escrowAlreadyFinalized).toBe(1);
        expect(result.summary.escrowDisputed).toBe(1);

        // Resolved escrow: booking cancelled, no second economic mutation.
        const resolvedBooking = await prisma.transitBooking.findUnique({ where: { id: resolved.booking.id } });
        expect(resolvedBooking.status).toBe('CANCELLED');
        expect(await payerSnapshot(resolved.customer.id)).toEqual(resolvedSnap);
        expect(await allEscrowLedgerCount(resolved.escrowId)).toBe(resolvedLedger);

        // Disputed escrow: booking cancelled (worker eligibility removed), escrow untouched.
        const disputedBooking = await prisma.transitBooking.findUnique({ where: { id: disputed.booking.id } });
        expect(disputedBooking.status).toBe('CANCELLED');
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: disputed.escrowId } });
        expect(escrowAfter.status).toBe('DISPUTED');
        expect(await payerSnapshot(disputed.customer.id)).toEqual(disputedSnap);
        expect(await refundLedgerCount(disputed.escrowId)).toBe(0); // never economically mutated by the cancellation (fund posting is ESCROW_FUND) // never economically mutated here
    });

    // A8 — legacy stranding recovery: CANCELLED booking with still-FUNDED escrow gets refunded.
    test('A8. legacy stranded booking (CANCELLED status, FUNDED escrow — exactly the old route\'s residue) is recovered and refunded', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedFundedBooking(ctx, { amountUsdc: 40 });
        // Simulate the old route's residue: booking cancelled, escrow still FUNDED.
        await prisma.transitBooking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
        await prisma.transitTrip.update({ where: { id: ctx.trip.id }, data: { status: 'CANCELLED' } });

        const result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: ctx.biz.id });

        expect(result.cancelled).toBe(true);
        expect(result.summary.refunded).toBe(1);
        expect(result.summary.failed).toBe(0);

        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('REFUNDED');
        const snap = await payerSnapshot(customer.id);
        expect(snap.locked).toBeCloseTo(0, 6);
        expect(snap.available).toBeCloseTo(500 - 40.2 + 40, 6);
    });

    // A9 — tenant isolation.
    test('A9. another business cannot cancel this trip: notFound, zero mutations, zero money moved', async () => {
        const ctx = await seedBusinessWithTrip();
        const { escrowId } = await seedFundedBooking(ctx, { amountUsdc: 40 });
        const { biz: otherBiz } = await seedBusiness(prisma);

        const result = await cancelTripWithRefunds(prisma, { tripId: ctx.trip.id, businessProfileId: otherBiz.id });

        expect(result.notFound).toBe(true);

        const trip = await prisma.transitTrip.findUnique({ where: { id: ctx.trip.id } });
        expect(trip.status).toBe('SCHEDULED');
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('FUNDED');
    });
});
