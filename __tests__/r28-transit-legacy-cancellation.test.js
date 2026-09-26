// __tests__/r28-transit-legacy-cancellation.test.js
// =============================================================================
// r28 / P0-C + P0-B race hardening — REAL PostgreSQL proofs that EVERY legacy
// transit booking cancellation entry point now funnels through the single
// transactionally authoritative cancellation core
// (services/transitBookingService.cancelTransitBooking, r28 canonical).
//
// These are NOT controller mocks: every case seeds real rows, funds real
// escrows through the canonical createBookingEscrow + fundBookingEscrow path,
// and asserts booking/seat/capacity/escrow/balance/ledger convergence in the
// actual database.
//
// Proves:
//   C1.  customer PENDING cancellation (seats, no escrow) => CANCELLED +
//        seat rows released + trip.availableSeats restored + zero money motion
//   C2.  customer CONFIRMED cancellation with funded escrow => escrow
//        REFUNDED, payer locked balance returns EXACTLY, ledger
//        ESCROW_REFUND + TransactionHistory appear exactly once
//   C3.  owner cancellation with funded escrow => same canonical economics
//   C4.  second cancellation => idempotent observed no-op, ZERO new
//        economic mutations
//   C5.  injected ledger failure through the PATCH route => honest 500
//        (never false success), FULL rollback (booking CONFIRMED, seats
//        intact, capacity unchanged, escrow FUNDED, locked balance intact,
//        no ledger/history residue); retry after the fault clears succeeds
//        cleanly
//   C6.  concurrent customer/owner cancellation => one economic winner,
//        exactly-once refund, deterministic convergence
//   C7.  concurrent cancellation vs business NO_SHOW split => exactly one
//        terminal economic operation wins; final booking status ALWAYS
//        corresponds to the economics that actually executed; the loser
//        performs no second mutation
//   C8.  splitReleaseFundedEscrow on an already-CANCELLED booking => CAS
//        guard throws, escrow untouched, no penalty/refund economics
//   C9.  cross-business stranger cancellation => 403, ZERO mutation
//   C10. IN_PROGRESS -> CANCELLED => 409 under the unified contract; no
//        contradictory second cancellation contract remains
//   C11. DISPUTED escrow => booking cancelled, escrow stays in dispute
//        custody, never economically mutated here
//   C12. already-finalized (REFUNDED) escrow => booking cancelled, no
//        second economic mutation, reported honestly
//   C13. expiry worker funnels through the canonical service => stale
//        PENDING booking cancelled atomically WITH capacity restore (the
//        old inline worker code never restored availableSeats)
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r28-transit-legacy-cancellation] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r28 P0-C: legacy transit booking cancellation is canonical, transactional and race-safe (real PostgreSQL)', () => {
    let prisma;
    let ctrl;
    let bookingEscrowService;
    let transitSvc;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ctrl = require('../controllers/transitController');
        bookingEscrowService = require('../services/bookingEscrowService');
        transitSvc = require('../services/transitBookingService');
    });
    afterAll(async () => { await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "TransactionHistory", "SystemProfitFees", "Ticket", "SmartEscrow", "User", "BusinessProfile", "BusinessProduct", "TransitVehicle", "TransitTrip", "TransitBooking", "TransitBookingSeat", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── harness ────────────────────────────────────────────────────────────
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

    async function seedBusinessWithTrip() {
        const { biz, owner } = await seedBusiness(prisma);
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'BUS', capacity: 30, licensePlate: `GT-C-${Date.now()}` },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id, vehicleId: vehicle.id,
                routeName: 'Accra-Cape Coast', origin: 'Accra', destination: 'Cape Coast',
                departureAt: new Date(Date.now() + 3600_000), fareUsdc: 20, availableSeats: 30,
            },
        });
        return { biz, owner, vehicle, trip };
    }

    let _seq = 0;
    // Seeds a booking that occupies 2 real seats (the canonical bookSeats
    // economics: seat rows created + availableSeats decremented), optionally
    // funded through the real escrow funding path.
    async function seedBooking(ctx, { status = 'CONFIRMED', amountUsdc = 40, seats = 2, fund = true, penaltyPct = null, escrowStatus = null } = {}) {
        const customer = await seedUser(prisma, { availableBalance: 500 });
        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: ctx.biz.id, customerId: customer.id, tripId: ctx.trip.id,
                pickupAddress: 'Accra Central', dropoffAddress: 'Cape Coast Station',
                amountUsdc,
                status,
                scheduledAt: new Date(Date.now() + 1800_000),
                bookingRef: `TRN-28-${Date.now()}-${++_seq}`,
                ...(penaltyPct != null ? { noShowPenaltyPct: penaltyPct } : {}),
            },
        });
        if (seats > 0) {
            await prisma.transitBookingSeat.createMany({
                data: Array.from({ length: seats }, (_, i) => ({
                    bookingId: booking.id, tripId: ctx.trip.id, seatId: `A${i + 1}`, passengerName: 'Test Rider',
                })),
            });
            await prisma.transitTrip.update({
                where: { id: ctx.trip.id },
                data: { availableSeats: { decrement: seats } },
            });
        }
        let escrowId = null;
        if (fund) {
            const { escrow } = await bookingEscrowService.createBookingEscrow(prisma, {
                bookingType: 'TRANSIT', bookingId: booking.id,
                payerId: customer.id, payeeId: ctx.owner.id,
                amountUsdc, businessProfileId: ctx.biz.id,
            });
            escrowId = escrow.id;
            if (escrowStatus === 'DRAFT') {
                // created but never funded — no money has moved
            } else {
                await bookingEscrowService.fundBookingEscrow(prisma, {
                    escrowId: escrow.id, payerId: customer.id,
                    bookingType: 'TRANSIT', bookingId: booking.id,
                });
                if (escrowStatus === 'DISPUTED') {
                    await prisma.smartEscrow.update({ where: { id: escrow.id }, data: { status: 'DISPUTED' } });
                } else if (escrowStatus === 'REFUNDED') {
                    await bookingEscrowService.refundBookingEscrow(prisma, { escrowId: escrow.id });
                }
            }
        }
        return { customer, booking, escrowId, seats };
    }

    const snap = async (userId) => {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: { availableBalance: true, escrowLockedBalance: true },
        });
        return { available: Number(u.availableBalance), locked: Number(u.escrowLockedBalance) };
    };
    const refundLedgerCount = (escrowId) =>
        prisma.ledgerTransaction.count({ where: { relatedEntityId: escrowId, entryType: 'ESCROW_REFUND' } });
    const releaseLedgerCount = (escrowId) =>
        prisma.ledgerTransaction.count({ where: { relatedEntityId: escrowId, entryType: 'ESCROW_RELEASE' } });
    const historyCount = (userId, type) =>
        prisma.transactionHistory.count({ where: { userId, type } });
    const seatRows = (bookingId) => prisma.transitBookingSeat.count({ where: { bookingId } });
    const tripCapacity = async (tripId) =>
        (await prisma.transitTrip.findUnique({ where: { id: tripId }, select: { availableSeats: true } })).availableSeats;

    const cancelViaController = (user, bookingId, body = {}) =>
        mockReqRes({ user: { id: user.id }, params: { id: bookingId }, body: { status: 'CANCELLED', ...body } });

    // ── C1 ──────────────────────────────────────────────────────────────────
    test('C1. customer PENDING cancellation (seats, no escrow) => CANCELLED + seats released + capacity restored + zero money motion', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking } = await seedBooking(ctx, { status: 'PENDING', fund: false, seats: 2 });
        expect(await tripCapacity(ctx.trip.id)).toBe(28);

        const { req, res } = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);
        expect(res.payload.refund).toBeNull();
        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CANCELLED');
        expect(await seatRows(booking.id)).toBe(0);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
        // Zero money motion: no ledger, no history for the customer.
        expect(await historyCount(customer.id, 'TICKET_ESCROW_REFUND')).toBe(0);
        expect(await snap(customer.id)).toEqual({ available: 500, locked: 0 });
    });

    // ── C2 ──────────────────────────────────────────────────────────────────
    test('C2. customer CONFIRMED cancellation with funded escrow => REFUNDED escrow, exact locked-balance restore, ledger + history exactly once, seats + capacity converge', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 2 });
        expect(await tripCapacity(ctx.trip.id)).toBe(28);

        const { req, res } = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.success).toBe(true);
        expect(res.payload.refund.outcome).toBe('REFUNDED');

        // Escrow + booking + seats + capacity all converged.
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('REFUNDED');
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CANCELLED');
        expect(await seatRows(booking.id)).toBe(0);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);

        // Payer's locked principal returned EXACTLY (funding locked 40 at a
        // 0.5% fee, so available went 500 -> 459.8; the refund restores 40).
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(0, 6);
        expect(payer.available).toBeCloseTo(500 - 40.2 + 40, 6);

        // Canonical economic identity, exactly once.
        expect(await refundLedgerCount(escrowId)).toBe(1);
        expect(await historyCount(customer.id, 'TICKET_ESCROW_REFUND')).toBe(1);
    });

    // ── C3 ──────────────────────────────────────────────────────────────────
    test('C3. owner cancellation with funded escrow => same canonical economics', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 25, seats: 1 });

        const { req, res } = await cancelViaController(ctx.owner, booking.id);
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.refund.outcome).toBe('REFUNDED');
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('REFUNDED');
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(0, 6);
        expect(payer.available).toBeCloseTo(500 - 25.125 + 25, 6);
        expect(await refundLedgerCount(escrowId)).toBe(1);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
    });

    // ── C4 ──────────────────────────────────────────────────────────────────
    test('C4. second cancellation => idempotent observed no-op, ZERO new economic mutations', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40 });

        const first = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(first.req, first.res);
        expect(first.res.statusCode).toBe(200);
        expect(first.res.payload.alreadyCancelled).toBe(false);

        const ledgerAfterFirst = await refundLedgerCount(escrowId);
        const payerAfterFirst = await snap(customer.id);

        // The controller's transition gate treats CANCELLED as terminal: a
        // re-cancel is an honest 409, never a second mutation.
        const second = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(second.req, second.res);
        expect(second.res.statusCode).toBe(409);
        expect(second.res.payload.success).toBe(false);

        // The canonical service below it converges idempotently: the claim
        // loses, it observes the resolved state and mutates NOTHING.
        const svcRetry = await transitSvc.cancelTransitBooking(prisma, {
            bookingId: booking.id, cancelledBy: customer.id,
        });
        expect(svcRetry.alreadyCancelled).toBe(true);
        expect(svcRetry.refund).toBeNull();

        // Nothing moved a second time.
        expect(await refundLedgerCount(escrowId)).toBe(ledgerAfterFirst);
        expect(await snap(customer.id)).toEqual(payerAfterFirst);
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CANCELLED');
    });

    // ── C5 ──────────────────────────────────────────────────────────────────
    test('C5. injected ledger failure through the PATCH route => honest 500, FULL rollback, no partial state; retry after the fault clears succeeds cleanly', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 2 });

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

        let res;
        try {
            const { req, res: r } = await cancelViaController(customer, booking.id);
            res = r;
            await ctrl.updateBookingStatus(req, r);
        } finally {
            require('../services/ledgerService').post = realPost;
        }

        // NEVER a false success.
        expect(res.statusCode).toBe(500);
        expect(res.payload.success).toBe(false);

        // FULL rollback — the booking+seats+capacity+escrow+ledger pair is
        // one transaction: nothing partially committed.
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CONFIRMED');
        expect(await seatRows(booking.id)).toBe(2);
        expect(await tripCapacity(ctx.trip.id)).toBe(28);
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrow.status).toBe('FUNDED');
        expect(await snap(customer.id)).toEqual({ available: 500 - 40.2, locked: 40 });
        expect(await refundLedgerCount(escrowId)).toBe(0);
        expect(await historyCount(customer.id, 'TICKET_ESCROW_REFUND')).toBe(0);

        // Retry with the fault cleared: clean, full convergence.
        const retry = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(retry.req, retry.res);
        expect(retry.res.statusCode).toBe(200);
        expect(retry.res.payload.refund.outcome).toBe('REFUNDED');
        const escrowFinal = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        expect(escrowFinal.status).toBe('REFUNDED');
        expect(await refundLedgerCount(escrowId)).toBe(1);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(0, 6);
        expect(payer.available).toBeCloseTo(500 - 40.2 + 40, 6);
    });

    // ── C6 ──────────────────────────────────────────────────────────────────
    test('C6. concurrent customer/owner cancellation => one economic winner, exactly-once refund, deterministic convergence', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 2 });

        const results = await Promise.allSettled([
            transitSvc.cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: customer.id }),
            transitSvc.cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: ctx.owner.id }),
        ]);
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const outcomes = results.map((r) => r.value);
        // Exactly one claim winner; the loser converges on the observed state.
        expect(outcomes.filter((o) => o.alreadyCancelled === false)).toHaveLength(1);
        expect(outcomes.filter((o) => o.alreadyCancelled === true)).toHaveLength(1);

        // Exactly-once economics.
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CANCELLED');
        expect(await refundLedgerCount(escrowId)).toBe(1);
        expect(await historyCount(customer.id, 'TICKET_ESCROW_REFUND')).toBe(1);
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(0, 6);
        expect(payer.available).toBeCloseTo(500 - 40.2 + 40, 6);
        // Capacity restored exactly once (no double increment).
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
        expect(await seatRows(booking.id)).toBe(0);
    });

    // ── C7 ──────────────────────────────────────────────────────────────────
    test('C7. concurrent cancellation vs business NO_SHOW split => exactly one terminal economic operation wins; final status matches the actual economics', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 1, penaltyPct: 0.25 });

        const results = await Promise.allSettled([
            transitSvc.cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: customer.id }),
            bookingEscrowService.splitReleaseFundedEscrow(prisma, {
                escrowId, penaltyPct: 0.25, reason: 'Business no-show', bookingType: 'TRANSIT', bookingId: booking.id,
            }),
        ]);

        // Exactly one economic winner — the loser either rolled back
        // entirely or converged on the observed state.
        const finalBooking = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        const finalEscrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
        const refundPostings = await refundLedgerCount(escrowId);
        const releasePostings = await releaseLedgerCount(escrowId);
        expect(refundPostings + releasePostings).toBe(1); // exactly one terminal economic mutation

        if (finalBooking.status === 'CANCELLED') {
            expect(finalEscrow.status).toBe('REFUNDED');
            expect(refundPostings).toBe(1);
            expect(releasePostings).toBe(0);
            // Cancellation also released the seat + capacity.
            expect(await seatRows(booking.id)).toBe(0);
            expect(await tripCapacity(ctx.trip.id)).toBe(30);
            const payer = await snap(customer.id);
            expect(payer.locked).toBeCloseTo(0, 6);
            expect(payer.available).toBeCloseTo(500 - 40.2 + 40, 6);
        } else {
            expect(finalBooking.status).toBe('NO_SHOW');
            expect(finalEscrow.status).toBe('RELEASED');
            expect(releasePostings).toBe(1);
            expect(refundPostings).toBe(0);
            // The split's canonical 25/75 economics executed exactly once.
            const payer = await snap(customer.id);
            expect(payer.locked).toBeCloseTo(0, 6);
            expect(payer.available).toBeCloseTo(500 - 40.2 + 30, 6);
            const payee = await snap(ctx.owner.id);
            expect(payee.available).toBeCloseTo(1000 + 10, 6);
            // The losing cancellation performed no seat/capacity mutation.
            expect(await seatRows(booking.id)).toBe(1);
            expect(await tripCapacity(ctx.trip.id)).toBe(29);
        }

        // The loser NEVER performs a second economic mutation: a post-race
        // cancellation converges on the terminal state.
        const lateCancel = await transitSvc.cancelTransitBooking(prisma, {
            bookingId: booking.id, cancelledBy: customer.id,
        }).catch((err) => ({ rejected: true, code: err.code }));
        if (lateCancel.rejected) {
            expect(lateCancel.code).toBe('NOT_CANCELLABLE');
        } else {
            expect(lateCancel.alreadyCancelled).toBe(true);
        }
        expect((await refundLedgerCount(escrowId)) + (await releaseLedgerCount(escrowId))).toBe(1);
    });

    // ── C8 ──────────────────────────────────────────────────────────────────
    test('C8. splitReleaseFundedEscrow on an already-CANCELLED booking => CAS guards reject, escrow untouched, no penalty economics (both stranded shapes)', async () => {
        const ctx = await seedBusinessWithTrip();

        // Shape 1 — full cancellation already refunded the escrow: the
        // split's ESCROW CAS rejects first (already finalized), and the
        // booking guard is the second wall behind it.
        const done = await seedBooking(ctx, { amountUsdc: 40, seats: 1, penaltyPct: 0.25 });
        await transitSvc.cancelTransitBooking(prisma, { bookingId: done.booking.id, cancelledBy: done.customer.id });
        const payerAfterCancel = await snap(done.customer.id);
        const payeeBefore = await snap(ctx.owner.id);

        await expect(bookingEscrowService.splitReleaseFundedEscrow(prisma, {
            escrowId: done.escrowId, penaltyPct: 0.25, reason: 'Stale no-show', bookingType: 'TRANSIT', bookingId: done.booking.id,
        })).rejects.toThrow('ESCROW_ALREADY_FINALIZED');

        // No second economic mutation at all.
        expect((await prisma.smartEscrow.findUnique({ where: { id: done.escrowId } })).status).toBe('REFUNDED');
        expect(await releaseLedgerCount(done.escrowId)).toBe(0);
        expect(await refundLedgerCount(done.escrowId)).toBe(1); // the cancellation's single refund
        expect(await snap(done.customer.id)).toEqual(payerAfterCancel);
        expect(await snap(ctx.owner.id)).toEqual(payeeBefore);
        expect((await prisma.transitBooking.findUnique({ where: { id: done.booking.id } })).status).toBe('CANCELLED');

        // Shape 2 — the direct booking CAS guard: the legacy stranding shape
        // (booking CANCELLED while the escrow is still FUNDED). The split's
        // escrow claim SUCCEEDS, then the booking guard rejects and the WHOLE
        // split rolls back — escrow restored, no penalty, no ledger.
        const stranded = await seedBooking(ctx, { amountUsdc: 40, seats: 1, penaltyPct: 0.25 });
        await prisma.transitBooking.update({
            where: { id: stranded.booking.id },
            data: { status: 'CANCELLED' }, // simulate the legacy stranded state directly
        });
        const payeeStrandedBefore = await snap(ctx.owner.id);

        await expect(bookingEscrowService.splitReleaseFundedEscrow(prisma, {
            escrowId: stranded.escrowId, penaltyPct: 0.25, reason: 'Stale no-show', bookingType: 'TRANSIT', bookingId: stranded.booking.id,
        })).rejects.toThrow('BOOKING_NO_LONGER_CONFIRMED');

        // The whole split rolled back: escrow still FUNDED, money still
        // locked, no release/penalty posting, payee untouched.
        expect((await prisma.smartEscrow.findUnique({ where: { id: stranded.escrowId } })).status).toBe('FUNDED');
        expect(await releaseLedgerCount(stranded.escrowId)).toBe(0);
        expect((await snap(stranded.customer.id)).locked).toBeCloseTo(40, 6);
        expect(await snap(ctx.owner.id)).toEqual(payeeStrandedBefore);
        expect((await prisma.transitBooking.findUnique({ where: { id: stranded.booking.id } })).status).toBe('CANCELLED');
    });

    // ── C9 ──────────────────────────────────────────────────────────────────
    test('C9. cross-business stranger cancellation => 403, ZERO mutation', async () => {
        const ctx = await seedBusinessWithTrip();
        const { booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 1 });
        const stranger = await seedUser(prisma, { availableBalance: 100 });
        const otherBiz = await seedBusiness(prisma, { businessName: 'Other Biz' });
        const otherOwner = otherBiz.owner;

        for (const intruder of [stranger, otherOwner]) {
            const { req, res } = await cancelViaController(intruder, booking.id);
            await ctrl.updateBookingStatus(req, res);
            expect(res.statusCode).toBe(403);
        }

        // Zero mutation: booking, escrow, seats, capacity, ledger all intact.
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CONFIRMED');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('FUNDED');
        expect(await seatRows(booking.id)).toBe(1);
        expect(await tripCapacity(ctx.trip.id)).toBe(29);
        expect(await refundLedgerCount(escrowId)).toBe(0);
    });

    // ── C10 ─────────────────────────────────────────────────────────────────
    test('C10. IN_PROGRESS -> CANCELLED => 409 under the unified contract; no contradictory cancellation contract remains', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { status: 'IN_PROGRESS', amountUsdc: 40, seats: 1 });

        for (const actor of [customer, ctx.owner]) {
            const { req, res } = await cancelViaController(actor, booking.id);
            await ctrl.updateBookingStatus(req, res);
            expect(res.statusCode).toBe(409);
        }

        // The service is the authoritative backstop with the same contract.
        await expect(transitSvc.cancelTransitBooking(prisma, { bookingId: booking.id, cancelledBy: ctx.owner.id }))
            .rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });

        // Zero mutation.
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('IN_PROGRESS');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('FUNDED');
        expect(await seatRows(booking.id)).toBe(1);
    });

    // ── C11 ─────────────────────────────────────────────────────────────────
    test('C11. DISPUTED escrow => booking cancelled, escrow stays in dispute custody, never economically mutated here', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 1, escrowStatus: 'DISPUTED' });

        const { req, res } = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.refund.outcome).toBe('ESCROW_DISPUTED');
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CANCELLED');
        // Dispute custody keeps the money: escrow stays DISPUTED, principal stays locked.
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('DISPUTED');
        const payer = await snap(customer.id);
        expect(payer.locked).toBeCloseTo(40, 6);
        expect(await refundLedgerCount(escrowId)).toBe(0);
        // Seats + capacity still released (the customer is not taking the ride).
        expect(await seatRows(booking.id)).toBe(0);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
    });

    // ── C12 ─────────────────────────────────────────────────────────────────
    test('C12. already-finalized (REFUNDED) escrow => booking cancelled, no second economic mutation, reported honestly', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking, escrowId } = await seedBooking(ctx, { amountUsdc: 40, seats: 1, escrowStatus: 'REFUNDED' });
        const escrowLedgerBefore = await prisma.ledgerTransaction.count({ where: { relatedEntityId: escrowId } });
        const payerBefore = await snap(customer.id);

        const { req, res } = await cancelViaController(customer, booking.id);
        await ctrl.updateBookingStatus(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.payload.refund.outcome).toBe('ESCROW_ALREADY_FINALIZED');
        expect((await prisma.transitBooking.findUnique({ where: { id: booking.id } })).status).toBe('CANCELLED');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('REFUNDED');
        // No second mutation: ledger count unchanged, balances unchanged.
        expect(await prisma.ledgerTransaction.count({ where: { relatedEntityId: escrowId } })).toBe(escrowLedgerBefore);
        expect(await snap(customer.id)).toEqual(payerBefore);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
    });

    // ── C13 ─────────────────────────────────────────────────────────────────
    test('C13. expiry worker funnels through the canonical service => stale PENDING booking cancelled atomically WITH capacity restore', async () => {
        const ctx = await seedBusinessWithTrip();
        const { customer, booking } = await seedBooking(ctx, { status: 'PENDING', fund: false, seats: 2 });
        // Backdate past the 15-minute payment window.
        await prisma.transitBooking.update({
            where: { id: booking.id },
            data: { createdAt: new Date(Date.now() - 16 * 60 * 1000) },
        });
        expect(await tripCapacity(ctx.trip.id)).toBe(28);

        const TransitBookingExpiryWorker = require('../workers/transitBookingExpiryWorker');
        const worker = new TransitBookingExpiryWorker(prisma, null, null);
        await worker._tick();

        const after = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
        expect(after.status).toBe('CANCELLED');
        expect(after.driverNote).toContain('Payment not completed');
        // The old inline worker code deleted seat rows but NEVER restored
        // capacity — the canonical path restores both, atomically.
        expect(await seatRows(booking.id)).toBe(0);
        expect(await tripCapacity(ctx.trip.id)).toBe(30);
        expect(await snap(customer.id)).toEqual({ available: 500, locked: 0 });
    });
});
