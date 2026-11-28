// =============================================================================
// Transit wallet pay — book AND pay in one transaction; release on completion.
//
// Runs against a small in-memory Prisma fake (no database), so the economic
// behaviour is checked on every run:
//   • payWith WALLET creates the booking escrow, debits fare + fee from the
//     passenger, locks the fare, confirms the booking and returns the payment
//   • the charge must equal the total the passenger approved (the quote)
//   • a short balance throws before anything commits
//   • nobody pays for their own trip, a departed trip, or the same seat twice
//   • a trip cancelled mid-booking refuses the booking inside the transaction
//   • the escrow outlives the trip (departure + the completion grace)
//   • a zero fee posts no fee ledger line
//   • a post-commit notice failure never turns a paid booking into an error
//   • completion releases the fare to the operator once, only for a
//     passenger boarded by their QR, never before the trip departs, and
//     reports an escrow it cannot release
//   • a paid booking boards only by the passenger's QR: manual check-in and
//     the operator's status write are refused; the QR records the method
//   • a business no-show without a penalty refunds the passenger
//   • the expiry worker's cancel is pinned to PENDING
// The real-PostgreSQL atomicity (rollback on failure) is covered by
// transit-wallet-pay.pg.test.js in CI.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messagingChannels', () => ({ notifyBookingConfirmed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ replayed: false }) }));
jest.mock('../services/escrowService', () => ({ _refundEscrow: jest.fn().mockResolvedValue({ id: 'refunded' }) }));

const ledger = require('../services/ledgerService');
const {
    bookSeats, quoteSeats, completeTransitBooking, cancelTransitBooking,
    noShowTransitBookingWithRefund, COMPLETION_GRACE_DAYS, rescheduleTripBookings,
} = require('../services/transitBookingService');

// ── a tiny in-memory Prisma (shared with transit-id-boarding.test.js) ───────
const { makeDb, DAY } = require('./helpers/transitPrismaFake');

const user = (db, id) => db.user.rows.find(u => u.id === id);
const trip = (db) => db.transitTrip.rows[0];
// Pays with the total the quote shows (the passenger's approval).
const pay = (db, seatIds, extra = {}) => quoteSeats(db, { tripId: 'trip-1', customerId: 10, seatIds })
    .then(q => bookSeats(db, {
        tripId: 'trip-1', customerId: 10, seatIds, payWith: 'WALLET',
        expectedTotalUsdc: q.totalUsdc.toFixed(6), ...extra,
    }));

describe('bookSeats with payWith WALLET', () => {
    beforeEach(() => ledger.post.mockClear());

    test('books, pays from the wallet and confirms, in one transaction', async () => {
        const db = makeDb();
        const res = await pay(db, ['1A', '2A'], { financialOperation: { id: 'op-1' } });

        expect(db.$transaction).toHaveBeenCalledTimes(1);
        // Fare is tier-aware: 2 (standard) + 5 (VIP) = 7; fee 0.5% = 0.035.
        expect(res.totalFare).toBe(7);
        expect(res.payment).toEqual(expect.objectContaining({
            method: 'WALLET', amountUsdc: 7, feeUsdc: 0.035, totalUsdc: 7.035,
        }));
        expect(res.booking.status).toBe('CONFIRMED');
        expect(res.booking.feeUsdc).toBe(0.035);
        expect(res.booking.escrowId).toBe(res.payment.escrowId);

        expect(user(db, 10).availableBalance).toBeCloseTo(100 - 7.035, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(7, 9);
        expect(user(db, 20).availableBalance).toBe(0);
        expect(db.smartEscrow.rows[0]).toEqual(expect.objectContaining({ status: 'FUNDED', payerId: 10, payeeId: 20, amountUsdc: 7 }));
        expect(ledger.post).toHaveBeenCalledWith(db, expect.objectContaining({ entryType: 'ESCROW_LOCK' }));

        const op = db.financialOperation.rows[0];
        expect(op.status).toBe('COMMITTED');
        expect(JSON.parse(op.responseBody).payment.totalUsdc).toBe(7.035);
        expect(db.transitBookingSeat.rows.map(s => s.seatId)).toEqual(['1A', '2A']);
        expect(trip(db).availableSeats).toBe(1);
    });

    test('the escrow outlives the trip: departure + the completion grace', async () => {
        const db = makeDb({ departInDays: 45 });
        await pay(db, ['1A']);
        const expiresAt = new Date(db.smartEscrow.rows[0].expiresAt).getTime();
        const departure = trip(db).departureAt.getTime();
        expect(expiresAt).toBeGreaterThanOrEqual(departure + COMPLETION_GRACE_DAYS * DAY - 1000);
    });

    test('the quote charges exactly what the booking charges', async () => {
        const db = makeDb({ fee: 0.01 });
        const quote = await quoteSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'] });
        expect(quote).toEqual(expect.objectContaining({
            currency: 'USDC', fareUsdc: 7, feeUsdc: 0.07, totalUsdc: 7.07, availableUsdc: 100, canPay: true,
        }));
        const res = await pay(db, ['1A', '2A']);
        expect(res.payment.totalUsdc).toBe(quote.totalUsdc);
    });

    test('a price change since the quote refuses before anything is claimed', async () => {
        const db = makeDb();
        await expect(bookSeats(db, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET', expectedTotalUsdc: '1.000000',
        })).rejects.toMatchObject({ code: 'PRICE_CHANGED', httpStatus: 409 });
        expect(db.$transaction).not.toHaveBeenCalled();
        await expect(bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET' }))
            .rejects.toMatchObject({ code: 'EXPECTED_TOTAL_REQUIRED' });
    });

    test('a zero fee posts no fee ledger line', async () => {
        const db = makeDb({ fee: 0 });
        const res = await pay(db, ['1A']);
        expect(res.payment.feeUsdc).toBe(0);
        const lines = ledger.post.mock.calls[0][1].lines;
        expect(lines.map(l => l.account)).not.toContain('revenue:fees');
        expect(lines.every(l => Number(l.debit || l.credit) > 0)).toBe(true);
    });

    test('a short balance throws before the claim commits', async () => {
        const db = makeDb({ passengerBalance: 1 });
        await expect(pay(db, ['1A'], { financialOperation: { id: 'op-1' } }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        expect(db.financialOperation.rows[0].status).toBe('IN_PROGRESS');
        expect(user(db, 10).availableBalance).toBe(1);
        expect(ledger.post).not.toHaveBeenCalled();
    });

    test('a trip cancelled mid-booking refuses it inside the transaction', async () => {
        const db = makeDb();
        const inner = db.$transaction;
        db.$transaction = jest.fn(async (cb) => { trip(db).status = 'CANCELLED'; return inner(cb); });
        await expect(pay(db, ['1A'])).rejects.toMatchObject({ code: 'TRIP_UNAVAILABLE' });
        expect(user(db, 10).availableBalance).toBe(100);
        expect(ledger.post).not.toHaveBeenCalled();
    });

    test('a departed trip, duplicate seats and your own trip are refused', async () => {
        const departed = makeDb({ departInDays: -1 });
        await expect(bookSeats(departed, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET', expectedTotalUsdc: '2.010000',
        })).rejects.toMatchObject({ code: 'TRIP_DEPARTED' });

        await expect(bookSeats(makeDb(), { tripId: 'trip-1', customerId: 10, seatIds: ['1A', '1A'], payWith: 'WALLET' }))
            .rejects.toMatchObject({ code: 'DUPLICATE_SEATS' });

        const own = makeDb({ operatorId: 10 });
        await expect(bookSeats(own, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET', expectedTotalUsdc: '2.010000' }))
            .rejects.toMatchObject({ code: 'SELF_PAYMENT', httpStatus: 409 });
        expect(own.$transaction).not.toHaveBeenCalled();
    });

    test('a post-commit notice failure never turns a paid booking into an error', async () => {
        const db = makeDb();
        // Only the post-commit notice reads the booking with findUnique.
        db.transitBooking.findUnique = jest.fn(async () => { throw new Error('db blip'); });
        const res = await pay(db, ['1A']);
        expect(res.booking.status).toBe('CONFIRMED');
    });

    test('the quote says when the wallet cannot cover it', async () => {
        const quote = await quoteSeats(makeDb({ passengerBalance: 1 }), { tripId: 'trip-1', customerId: 10, seatIds: ['1A'] });
        expect(quote.canPay).toBe(false);
    });

    test('an unknown payment method is refused before anything happens', async () => {
        const db = makeDb();
        await expect(bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'MOMO' }))
            .rejects.toMatchObject({ code: 'UNSUPPORTED_PAYMENT_METHOD' });
        expect(db.$transaction).not.toHaveBeenCalled();
    });

    test('without payWith it stays a plain PENDING reservation, no money', async () => {
        const db = makeDb();
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'] });
        expect(res.booking.status).toBe('PENDING');
        expect(res.payment).toBeUndefined();
        expect(db.smartEscrow.rows).toHaveLength(0);
        expect(user(db, 10).availableBalance).toBe(100);
    });
});

describe('completeTransitBooking', () => {
    async function paidAndBoarded({ departed = true } = {}) {
        const db = makeDb();
        const res = await pay(db, ['1A']);
        db.transitBooking.rows[0].status = 'IN_PROGRESS'; // boarded by QR
        db.transitBooking.rows[0].metadata = { boarding: { method: 'QR_TOKEN' } };
        if (departed) trip(db).departureAt = new Date(Date.now() - 60 * 60 * 1000);
        return { db, bookingId: res.booking.id };
    }

    test('releases the fare to the operator with the status claim', async () => {
        const { db, bookingId } = await paidAndBoarded();
        const out = await completeTransitBooking(db, { bookingId });
        expect(out.booking.status).toBe('COMPLETED');
        expect(out.release).toEqual(expect.objectContaining({ amountUsdc: 2 }));
        expect(db.smartEscrow.rows[0].status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBe(2);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
        expect(db.$executeRaw).toHaveBeenCalled();
    });

    test('a paid trip cannot be completed before it departs', async () => {
        const { db, bookingId } = await paidAndBoarded({ departed: false });
        await expect(completeTransitBooking(db, { bookingId }))
            .rejects.toMatchObject({ code: 'TOO_EARLY', httpStatus: 409 });
        expect(db.smartEscrow.rows[0].status).toBe('FUNDED');
        expect(user(db, 20).availableBalance).toBe(0);
        expect(db.transitBooking.rows[0].status).toBe('IN_PROGRESS');
    });

    test('a paid trip not boarded by QR is never released', async () => {
        const { db, bookingId } = await paidAndBoarded();
        db.transitBooking.rows[0].metadata = { boarding: { method: 'MANUAL' } };
        await expect(completeTransitBooking(db, { bookingId }))
            .rejects.toMatchObject({ code: 'QR_BOARDING_REQUIRED', httpStatus: 409 });
        expect(db.smartEscrow.rows[0].status).toBe('FUNDED');
        expect(user(db, 20).availableBalance).toBe(0);
        expect(db.transitBooking.rows[0].status).toBe('IN_PROGRESS');
    });

    test('completing twice converges without paying twice', async () => {
        const { db, bookingId } = await paidAndBoarded();
        await completeTransitBooking(db, { bookingId });
        const again = await completeTransitBooking(db, { bookingId });
        expect(again.alreadyCompleted).toBe(true);
        expect(again.release).toBeNull();
        expect(user(db, 20).availableBalance).toBe(2);
    });

    test('an escrow that can no longer be released is reported, not hidden', async () => {
        const { db, bookingId } = await paidAndBoarded();
        db.smartEscrow.rows[0].status = 'EXPIRED';
        const out = await completeTransitBooking(db, { bookingId });
        expect(out.release).toBeNull();
        expect(out.escrowNotReleased).toEqual(expect.objectContaining({ escrowStatus: 'EXPIRED' }));
    });

    test('a booking that has not boarded cannot be completed', async () => {
        const db = makeDb();
        const res = await pay(db, ['1A']);
        trip(db).departureAt = new Date(Date.now() - 60 * 60 * 1000);
        // A paid booking that never boarded (by QR) is refused, and paid nothing.
        await expect(completeTransitBooking(db, { bookingId: res.booking.id }))
            .rejects.toMatchObject({ code: 'QR_BOARDING_REQUIRED', httpStatus: 409 });
        expect(user(db, 20).availableBalance).toBe(0);
    });
});

describe('business no-show without a penalty', () => {
    test('refunds the passenger with the NO_SHOW claim (after the window)', async () => {
        const db = makeDb();
        const res = await pay(db, ['1A']);
        db.transitBooking.rows[0].driverNote = 'seat 1A, blue bag';
        trip(db).departureAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const out = await noShowTransitBookingWithRefund(db, { bookingId: res.booking.id });
        // An existing note survives a no-show without one.
        expect(db.transitBooking.rows[0].driverNote).toBe('seat 1A, blue bag');
        expect(out.booking.status).toBe('NO_SHOW');
        expect(out.refund).toEqual(expect.objectContaining({ amountUsdc: 2 }));
        expect(db.smartEscrow.rows[0].status).toBe('REFUNDED');
        // The fare comes back; the fee was realized at payment.
        expect(user(db, 10).availableBalance).toBeCloseTo(100 - 0.01, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
    });
});

describe('expiry cancel is pinned to PENDING', () => {
    test('a booking paid before the expiry claim is not cancelled or refunded', async () => {
        const db = makeDb();
        const res = await pay(db, ['1A']);
        db.transitBooking.rows[0].seats = [];
        db.transitBooking.rows[0].businessProfile = { userId: 20 };
        await expect(cancelTransitBooking(db, {
            bookingId: res.booking.id, cancelledBy: 10, onlyFromStatuses: ['PENDING'],
        })).rejects.toMatchObject({ code: 'NOT_CANCELLABLE' });
        expect(db.transitBooking.rows[0].status).toBe('CONFIRMED');
        expect(db.smartEscrow.rows[0].status).toBe('FUNDED');
    });
});

describe('bookTripSeats error contract', () => {
    const ctrl = require('../controllers/marketplaceController');
    const call = async (db, body) => {
        let status = null; let payload = null;
        const res = {
            locals: {},
            status(c) { status = c; return this; },
            json(p) { payload = p; return this; },
        };
        await ctrl.bookTripSeats({
            app: { get: () => db }, params: { id: 'trip-1' }, user: { id: 10 }, body,
        }, res);
        return { status, payload };
    };

    test('our own codes reach the app with their status', async () => {
        const out = await call(makeDb({ operatorId: 10 }), { seatIds: ['1A'], payWith: 'WALLET', expectedTotalUsdc: '2.010000' });
        expect(out.status).toBe(409);
        expect(out.payload).toEqual(expect.objectContaining({ success: false, code: 'SELF_PAYMENT' }));
    });

    test('a short balance is 402 INSUFFICIENT_BALANCE', async () => {
        const out = await call(makeDb({ passengerBalance: 1 }), { seatIds: ['1A'], payWith: 'WALLET', expectedTotalUsdc: '2.010000' });
        expect(out.status).toBe(402);
        expect(out.payload.code).toBe('INSUFFICIENT_BALANCE');
    });

    test('a Prisma code stays internal', async () => {
        const db = makeDb();
        db.$transaction = jest.fn(async () => { throw Object.assign(new Error('boom'), { code: 'P2034' }); });
        const out = await call(db, { seatIds: ['1A'] });
        expect(out.status).toBe(400);
        expect(out.payload.code).toBeUndefined();
    });
});

describe('route wiring', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/marketplaceRoutes.js'), 'utf-8');

    test('wallet-pay gates (ban, KYC, Idempotency-Key) run before the second factor', () => {
        const line = src.split('\n').find(l => l.includes("'/transit/trips/:id/book'") && l.includes('router'));
        expect(line).toBeTruthy();
        expect(line.indexOf('...walletPayGates')).toBeGreaterThan(-1);
        expect(line.indexOf('...walletPayGates')).toBeLessThan(line.indexOf('require2FA()'));
        expect(src).toContain("whenPayingWithWallet(requireKyc('pay'))");
        expect(src).toContain('whenPayingWithWallet(checkBan)');
        expect(src).toContain('whenPayingWithWallet(requireIdempotencyKey)');
    });

    test('the quote route is read-only (GET)', () => {
        expect(src).toContain("router.get('/transit/trips/:id/quote', protect, ctrl.quoteTripSeats)");
    });
});

describe('a paid booking boards only by the passenger QR', () => {
    const qr = require('../services/qrCheckInService');
    const TEST_ONLY_KEY = 'test-only-qr-signing-key-not-a-secret-0123456789';
    let savedKey;
    beforeAll(() => { savedKey = process.env.QR_CHECKIN_SIGNING_KEY; process.env.QR_CHECKIN_SIGNING_KEY = TEST_ONLY_KEY; });
    afterAll(() => { process.env.QR_CHECKIN_SIGNING_KEY = savedKey; });

    // A paid booking, decorated with the relations the check-in paths read.
    async function paidBooking() {
        const db = makeDb();
        const res = await pay(db, ['1A']);
        const row = db.transitBooking.rows[0];
        row.businessProfile = { userId: 20 };
        row.seats = [{ seatId: '1A', passengerName: null }];
        return { db, row, bookingId: res.booking.id };
    }

    test('manual check-in by booking id is refused', async () => {
        const { db, bookingId, row } = await paidBooking();
        await expect(qr.transitCheckIn(db, { bookingId, businessUserId: 20 }))
            .rejects.toMatchObject({ code: 'QR_BOARDING_REQUIRED' });
        expect(row.status).toBe('CONFIRMED');
    });

    test('an unpaid booking still checks in manually, recorded as MANUAL', async () => {
        const db = makeDb();
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'] });
        const row = db.transitBooking.rows[0];
        row.status = 'CONFIRMED';
        row.businessProfile = { userId: 20 };
        await qr.transitCheckIn(db, { bookingId: res.booking.id, businessUserId: 20 });
        expect(row.status).toBe('IN_PROGRESS');
        expect(row.metadata.boarding.method).toBe('MANUAL');
    });

    test('the operator cannot board a paid booking with a status write', async () => {
        const { db, bookingId } = await paidBooking();
        const ctrl = require('../controllers/transitController');
        let status = null; let payload = null;
        await ctrl.updateBookingStatus({
            app: { get: (k) => (k === 'prisma' ? db : null) },
            params: { id: bookingId }, user: { id: 20 }, body: { status: 'IN_PROGRESS' },
        }, {
            status(c) { status = c; return this; },
            json(p) { payload = p; return this; },
        });
        expect(status).toBe(409);
        expect(payload.code).toBe('QR_BOARDING_REQUIRED');
        expect(db.transitBooking.rows[0].status).toBe('CONFIRMED');
    });

    test('scan, board, depart, complete: the fare reaches the operator', async () => {
        const { db, row, bookingId } = await paidBooking();
        // The boarding window opens an hour before departure.
        trip(db).departureAt = new Date(Date.now() + 30 * 60 * 1000);
        row.trip = { id: 'trip-1', departureAt: trip(db).departureAt };
        const { token } = await qr.generateTransitCheckInToken(db, { bookingId, customerId: 10 });
        await qr.verifyTransitTokenAndBoard(db, { token, businessUserId: 20 });
        expect(row.status).toBe('IN_PROGRESS');
        expect(row.metadata.boarding.method).toBe('QR_TOKEN');

        // Departed: completion releases the fare.
        trip(db).departureAt = new Date(Date.now() - 60 * 1000);
        const out = await completeTransitBooking(db, { bookingId });
        expect(out.release).toEqual(expect.objectContaining({ amountUsdc: 2 }));
        expect(user(db, 20).availableBalance).toBe(2);
    });
});

describe('re-review: no way around the QR rule', () => {
    const ctrlT = require('../controllers/transitController');
    const ctrlM = require('../controllers/marketplaceController');
    const call = async (fn, req) => {
        let status = null; let payload = null;
        await fn(req, {
            locals: {},
            status(c) { status = c; return this; },
            json(p) { payload = p; return this; },
        });
        return { status, payload };
    };
    async function paidBooking() {
        const db = makeDb();
        const res = await pay(db, ['1A']);
        const row = db.transitBooking.rows[0];
        row.businessProfile = { userId: 20 };
        return { db, row, bookingId: res.booking.id };
    }

    test('a paid booking\'s penalty cannot be set after payment', async () => {
        const { db, bookingId, row } = await paidBooking();
        const out = await call(ctrlM.setPenaltyPolicy, {
            app: { get: () => db }, user: { id: 20 },
            body: { transitBookingId: bookingId, noShowPenaltyUsdc: 2 },
        });
        expect(out.status).toBe(409);
        expect(out.payload.code).toBe('PENALTY_LOCKED');
        expect(row.noShowPenaltyUsdc).toBeUndefined();
    });

    test('an unpaid booking\'s flat penalty is capped like the percentage', async () => {
        const db = makeDb();
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'] });
        const out = await call(ctrlM.setPenaltyPolicy, {
            app: { get: () => db }, user: { id: 20 },
            body: { transitBookingId: res.booking.id, noShowPenaltyUsdc: 2 },
        });
        expect(out.status).toBe(400);
    });

    test('a paid passenger is not a no-show while the boarding window is open', async () => {
        const { db, bookingId, row } = await paidBooking();
        trip(db).departureAt = new Date(Date.now() - 30 * 60 * 1000); // QR still valid
        const out = await call(ctrlT.updateBookingStatus, {
            app: { get: (k) => (k === 'prisma' ? db : null) },
            params: { id: bookingId }, user: { id: 20 }, body: { status: 'NO_SHOW' },
        });
        expect(out.status).toBe(409);
        expect(out.payload.code).toBe('TOO_EARLY');
        expect(row.status).toBe('CONFIRMED');
        expect(db.smartEscrow.rows[0].status).toBe('FUNDED');
    });

    test('the approved total must be an exact decimal', async () => {
        const db = makeDb();
        for (const bad of ['7.0349996', ['7.035'], '0x7', '7e0']) {
            await expect(bookSeats(db, {
                tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'], payWith: 'WALLET', expectedTotalUsdc: bad,
            })).rejects.toMatchObject({ code: 'EXPECTED_TOTAL_INVALID' });
        }
        const ok = await bookSeats(db, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'], payWith: 'WALLET', expectedTotalUsdc: '7.035',
        });
        expect(ok.payment.totalUsdc).toBe(7.035);
    });

    test('a moved departure moves the bookings and extends the escrow', async () => {
        const { db, row } = await paidBooking();
        const later = new Date(Date.now() + 40 * DAY);
        trip(db).departureAt = later;
        row.tripId = 'trip-1';
        await rescheduleTripBookings(db, { tripId: 'trip-1', departureAt: later });
        expect(new Date(row.scheduledAt).getTime()).toBe(later.getTime());
        expect(new Date(db.smartEscrow.rows[0].expiresAt).getTime())
            .toBe(later.getTime() + COMPLETION_GRACE_DAYS * DAY);
    });

    test('wallet pay accepts only the header the idempotency middleware claims on', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../routes/marketplaceRoutes.js'), 'utf-8');
        const gate = src.slice(src.indexOf('const requireIdempotencyKey'), src.indexOf('const walletPayGates'));
        expect(gate).toContain("req.get('idempotency-key')");
        expect(gate).not.toContain('x-idempotency-key');
    });

    test('escrow expiry completes a QR-boarded passenger instead of refunding', async () => {
        const escrowService = require('../services/escrowService');
        escrowService._refundEscrow.mockClear();
        const { db, row } = await paidBooking();
        row.status = 'IN_PROGRESS';
        row.metadata = { boarding: { method: 'QR_TOKEN' } };
        trip(db).departureAt = new Date(Date.now() - 8 * DAY);
        db.smartEscrow.rows[0].expiresAt = new Date(Date.now() - 1000);
        const EscrowExpiryWorker = require('../workers/escrowExpiryWorker');
        const Worker = EscrowExpiryWorker.EscrowExpiryWorker || EscrowExpiryWorker;
        const worker = new Worker(db, null, null, {});
        await worker._expireInactiveFunded(new Date());
        expect(escrowService._refundEscrow).not.toHaveBeenCalled();
        expect(row.status).toBe('COMPLETED');
        expect(db.smartEscrow.rows[0].status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBe(2);
    });
});

describe('round three: reschedule stays in step with the trip', () => {
    test('a trip postponed since the read refuses the booking inside the transaction', async () => {
        const db = makeDb();
        // Like Prisma, the read is a snapshot, not the live row.
        const live = db.transitTrip.findUnique;
        db.transitTrip.findUnique = jest.fn(async (args) => ({ ...(await live(args)) }));
        const inner = db.$transaction;
        db.$transaction = jest.fn(async (cb) => {
            trip(db).departureAt = new Date(trip(db).departureAt.getTime() + 3 * 60 * 60 * 1000);
            return inner(cb);
        });
        await expect(pay(db, ['1A'])).rejects.toMatchObject({ code: 'TRIP_UNAVAILABLE' });
        expect(user(db, 10).availableBalance).toBe(100);
    });

    test('a JSON number total must already be exact at 6 decimals', async () => {
        const db = makeDb();
        await expect(bookSeats(db, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'], payWith: 'WALLET', expectedTotalUsdc: 7.0349996,
        })).rejects.toMatchObject({ code: 'EXPECTED_TOTAL_INVALID' });
        const ok = await bookSeats(db, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'], payWith: 'WALLET', expectedTotalUsdc: 7.035,
        });
        expect(ok.payment.totalUsdc).toBe(7.035);
    });

    test('PATCH moves the departure and its bookings in one transaction', async () => {
        const db = makeDb();
        await pay(db, ['1A']);
        const ctrl = require('../controllers/marketplaceController');
        // Far enough out to pass the 30-day funded window (escrows only extend).
        const later = new Date(Date.now() + 40 * DAY);
        let status = null;
        await ctrl.updateTransitTrip({
            app: { get: () => db }, user: { id: 20 }, params: { id: 'trip-1' },
            body: { departureAt: later.toISOString() },
        }, {
            status(c) { status = c; return this; },
            json() { return this; },
        });
        expect(status).toBe(200);
        expect(db.$transaction).toHaveBeenCalled();
        expect(new Date(db.transitBooking.rows[0].scheduledAt).getTime()).toBe(later.getTime());
        expect(new Date(db.smartEscrow.rows[0].expiresAt).getTime())
            .toBe(later.getTime() + COMPLETION_GRACE_DAYS * DAY);
    });
});
