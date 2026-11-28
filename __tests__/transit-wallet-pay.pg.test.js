'use strict';

// =============================================================================
// TRANSIT WALLET PAY (real PostgreSQL).
//
// What the in-memory suite (transit-wallet-pay.test.js) cannot prove: that
// booking and paying are ONE database transaction. Against real PostgreSQL:
//   W1. payWith WALLET: booking CONFIRMED, escrow FUNDED, passenger debited
//       fare + fee, the fare locked, the operator not yet paid.
//   W2. A short balance rolls back EVERYTHING: no booking, no seat rows, no
//       ticket, no escrow, trip capacity and the balance untouched.
//   W3. Through the real idempotency middleware and controller: a short
//       balance answers 402 INSUFFICIENT_BALANCE and releases the key, so
//       the same key carries the retry after a top-up.
//   W4. Completion releases the fare to the operator and unlocks the
//       passenger's locked balance, in one commit; a second completion is a
//       no-op.
//   W5. The expiry worker's cancel (pinned to PENDING) refuses a booking
//       that was paid in between: it stays CONFIRMED and FUNDED.
//   W6. Cancelling the trip refunds a paid booking (fare back, fee kept).
//   W7. A paid trip cannot be completed before it departs.
//   W8. A paid booking cannot be boarded manually or completed without
//       QR boarding; nothing reaches the operator.
// =============================================================================

const { seedUser, seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('transit wallet pay (PostgreSQL)', () => {
    let prisma;
    let svc;

    const truncate = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "User", "BusinessProfile", "TransitVehicle", "TransitTrip", "TransitSeatMap", ' +
        '"TransitBooking", "TransitBookingSeat", "Ticket", "SmartEscrow", "SystemProfitFees", ' +
        '"AdminProfitLog", "FinancialOperation" RESTART IDENTITY CASCADE'
    );

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        svc = require('../services/transitBookingService');
    });
    afterAll(async () => { await prisma.$disconnect(); });
    beforeEach(truncate, 15000);
    afterEach(truncate, 15000);

    const SEATS = ['1A', '1B', '1C', '1D'];

    async function seedTrip({ balance = 500 } = {}) {
        const { owner, biz } = await seedBusiness(prisma, { owner: { availableBalance: 0 } });
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'VAN', capacity: 4 },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id, vehicleId: vehicle.id, routeName: 'Circle-Madina',
                origin: 'Circle', destination: 'Madina',
                departureAt: new Date(Date.now() + 3600_000), fareUsdc: 10, availableSeats: 4,
            },
        });
        await prisma.transitSeatMap.create({
            data: {
                vehicleId: vehicle.id,
                layout: SEATS.map((s, i) => ({ seatId: s, row: 1, col: i + 1, type: 'WINDOW' })),
                rows: 1, cols: 4,
            },
        });
        const customer = await seedUser(prisma, { availableBalance: balance });
        return { owner, biz, trip, customer };
    }

    const pay = async (tripId, customerId, seatIds) => {
        const q = await svc.quoteSeats(prisma, { tripId, customerId, seatIds });
        return svc.bookSeats(prisma, {
            tripId, customerId, seatIds, payWith: 'WALLET', expectedTotalUsdc: q.totalUsdc.toFixed(6),
        });
    };
    const depart = (tripId) => prisma.transitTrip.update({
        where: { id: tripId }, data: { departureAt: new Date(Date.now() - 3600_000) },
    });

    const balances = async (id) => {
        const u = await prisma.user.findUnique({ where: { id }, select: { availableBalance: true, escrowLockedBalance: true } });
        return { available: Number(u.availableBalance), locked: Number(u.escrowLockedBalance) };
    };

    test('W1: books, pays and confirms in one commit', async () => {
        const { owner, trip, customer } = await seedTrip();
        const res = await pay(trip.id, customer.id, ['1A']);
        expect(res.booking.status).toBe('CONFIRMED');
        expect(res.payment.amountUsdc).toBe(10);
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: res.payment.escrowId } });
        expect(escrow.status).toBe('FUNDED');
        const fee = Number(escrow.feeUsdc);
        const after = await balances(customer.id);
        expect(after.available).toBeCloseTo(500 - 10 - fee, 8);
        expect(after.locked).toBeCloseTo(10, 8);
        expect((await balances(owner.id)).available).toBe(0);
        expect((await prisma.transitTrip.findUnique({ where: { id: trip.id } })).availableSeats).toBe(3);
    });

    test('W2: a short balance rolls back the seats and the booking too', async () => {
        const { trip, customer } = await seedTrip({ balance: 5 });
        await expect(pay(trip.id, customer.id, ['1A']))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        expect(await prisma.transitBooking.count()).toBe(0);
        expect(await prisma.transitBookingSeat.count()).toBe(0);
        expect(await prisma.ticket.count()).toBe(0);
        expect(await prisma.smartEscrow.count()).toBe(0);
        expect((await prisma.transitTrip.findUnique({ where: { id: trip.id } })).availableSeats).toBe(4);
        expect(await balances(customer.id)).toEqual({ available: 5, locked: 0 });
    });

    test('W3: 402 through the real middleware releases the key for the retry', async () => {
        const { idempotency } = require('../middleware/idempotency');
        const ctrl = require('../controllers/marketplaceController');
        const mw = idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, required: false });
        const { trip, customer } = await seedTrip({ balance: 5 });
        const total = (await svc.quoteSeats(prisma, { tripId: trip.id, customerId: customer.id, seatIds: ['1A'] }))
            .totalUsdc.toFixed(6);

        const call = () => new Promise((resolve, reject) => {
            const settings = { prisma };
            const req = {
                method: 'POST', baseUrl: '/api/marketplace',
                route: { path: '/transit/trips/:id/book' },
                path: `/api/marketplace/transit/trips/${trip.id}/book`,
                url: `/api/marketplace/transit/trips/${trip.id}/book`,
                params: { id: trip.id }, query: {},
                headers: { 'idempotency-key': 'key-W3' },
                get(h) { return this.headers[String(h).toLowerCase()]; },
                body: { seatIds: ['1A'], payWith: 'WALLET', expectedTotalUsdc: total, businessProfileId: null },
                user: { id: customer.id },
                app: { get: (k) => settings[k] },
            };
            const res = {
                statusCode: 200, locals: {},
                status(c) { this.statusCode = c; return this; },
                json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
            };
            mw(req, res, async (err) => {
                if (err) return reject(err);
                try { await ctrl.bookTripSeats(req, res); } catch (e) { reject(e); }
            }).catch(reject);
        });

        const first = await call();
        expect(first.status).toBe(402);
        expect(first.body.code).toBe('INSUFFICIENT_BALANCE');
        // Released after delivery; give the post-response release a moment.
        for (let i = 0; i < 20; i++) {
            const claim = await prisma.financialOperation.findFirst({ where: { userId: customer.id, key: 'key-W3' } });
            if (!claim) break;
            await new Promise(r => setTimeout(r, 50));
        }
        expect(await prisma.financialOperation.findFirst({ where: { userId: customer.id, key: 'key-W3' } })).toBeNull();

        // A real top-up: the balance AND its ledger row (runDoubleCheck
        // recomputes the balance from COMPLETED history before any payment).
        await prisma.$transaction([
            prisma.user.update({ where: { id: customer.id }, data: { availableBalance: 100 } }),
            prisma.transactionHistory.create({
                data: { userId: customer.id, type: 'DEPOSIT_CRYPTO', amountUsdc: 95, feeUsdc: 0, status: 'COMPLETED' },
            }),
        ]);
        const retry = await call();
        expect(retry.status).toBe(201);
        expect(retry.body.booking.status).toBe('CONFIRMED');
    });

    test('W4: completion releases the fare to the operator, once', async () => {
        const { owner, customer, trip } = await seedTrip();
        const res = await pay(trip.id, customer.id, ['1A']);
        await prisma.transitBooking.update({
            where: { id: res.booking.id },
            // Boarded by the passenger's QR (the only boarding that releases a paid fare).
            data: { status: 'IN_PROGRESS', metadata: { boarding: { method: 'QR_TOKEN' } } },
        });
        await depart(trip.id);

        const done = await svc.completeTransitBooking(prisma, { bookingId: res.booking.id });
        expect(done.booking.status).toBe('COMPLETED');
        expect((await balances(owner.id)).available).toBe(10);
        expect((await balances(customer.id)).locked).toBe(0);
        expect((await prisma.smartEscrow.findUnique({ where: { id: res.payment.escrowId } })).status).toBe('SETTLED');

        const again = await svc.completeTransitBooking(prisma, { bookingId: res.booking.id });
        expect(again.alreadyCompleted).toBe(true);
        expect((await balances(owner.id)).available).toBe(10);
    });

    test('W5: the PENDING-pinned expiry cancel refuses a paid booking', async () => {
        const { customer, trip } = await seedTrip();
        const res = await pay(trip.id, customer.id, ['1A']);
        await expect(svc.cancelTransitBooking(prisma, {
            bookingId: res.booking.id, cancelledBy: customer.id, onlyFromStatuses: ['PENDING'],
        })).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });
        expect((await prisma.transitBooking.findUnique({ where: { id: res.booking.id } })).status).toBe('CONFIRMED');
        expect((await prisma.smartEscrow.findUnique({ where: { id: res.payment.escrowId } })).status).toBe('FUNDED');
    });

    test('W6: cancelling the trip refunds a paid booking', async () => {
        const { biz, customer, trip } = await seedTrip();
        const res = await pay(trip.id, customer.id, ['1A']);
        const fee = Number((await prisma.smartEscrow.findUnique({ where: { id: res.payment.escrowId } })).feeUsdc);
        const { cancelTripWithRefunds } = require('../services/transitTripCancellationService');
        const out = await cancelTripWithRefunds(prisma, { tripId: trip.id, businessProfileId: biz.id });
        expect(out.cancelled).toBe(true);
        expect(out.summary.refunded).toBe(1);
        expect((await prisma.smartEscrow.findUnique({ where: { id: res.payment.escrowId } })).status).toBe('REFUNDED');
        const after = await balances(customer.id);
        expect(after.available).toBeCloseTo(500 - fee, 8);
        expect(after.locked).toBeCloseTo(0, 8);
        // And nothing more can be booked on it.
        const other = await seedUser(prisma, { availableBalance: 50 });
        await expect(svc.bookSeats(prisma, { tripId: trip.id, customerId: other.id, seatIds: ['1B'] }))
            .rejects.toThrow();
    });

    test('W7: a paid trip cannot be completed before it departs', async () => {
        const { owner, customer, trip } = await seedTrip();
        const res = await pay(trip.id, customer.id, ['1A']);
        await prisma.transitBooking.update({
            where: { id: res.booking.id },
            // Boarded by the passenger's QR (the only boarding that releases a paid fare).
            data: { status: 'IN_PROGRESS', metadata: { boarding: { method: 'QR_TOKEN' } } },
        });
        await expect(svc.completeTransitBooking(prisma, { bookingId: res.booking.id }))
            .rejects.toMatchObject({ code: 'TOO_EARLY' });
        expect((await balances(owner.id)).available).toBe(0);
        expect((await prisma.smartEscrow.findUnique({ where: { id: res.payment.escrowId } })).status).toBe('FUNDED');
    });

    test('W8: a paid booking boards only by the passenger QR', async () => {
        const { owner, customer, trip } = await seedTrip();
        const res = await pay(trip.id, customer.id, ['1A']);
        const qr = require('../services/qrCheckInService');
        await expect(qr.transitCheckIn(prisma, { bookingId: res.booking.id, businessUserId: owner.id }))
            .rejects.toMatchObject({ code: 'QR_BOARDING_REQUIRED' });
        // Forced into IN_PROGRESS without the QR, it still never releases.
        await prisma.transitBooking.update({ where: { id: res.booking.id }, data: { status: 'IN_PROGRESS' } });
        await depart(trip.id);
        await expect(svc.completeTransitBooking(prisma, { bookingId: res.booking.id }))
            .rejects.toMatchObject({ code: 'QR_BOARDING_REQUIRED' });
        expect((await balances(owner.id)).available).toBe(0);
    });
});
