// =============================================================================
// Transit boarding by ID check, beside the passenger's own QR.
//
// In-memory Prisma (helpers/transitPrismaFake), so it runs anywhere:
//   • the manifest lists every passenger by seat with AZM-ID, names, photo,
//     payment and boarding, for the trip's own business only
//   • the AZM-ID check-in search returns the passenger's transit bookings;
//     the legal name only for a passenger with a booking here
//   • staff board a paid passenger after an ID check, inside the boarding
//     window, when the business allows it; a wrong AZM-ID boards nothing
//   • "QR only" refuses every ID check
//   • an unconfirmed ID check completes the trip but holds the fare until
//     departure + 24h; the sweep releases it then; a report keeps it
//   • the passenger's confirmation releases a completed trip's fare at once
//   • the escrow expiry worker releases a held ID-check fare, never refunds it
//   • the controller tells the passenger they were boarded
//   • the hold is fixed at boarding: moving the departure cannot shorten it,
//     a departure cannot be backdated, nor pulled earlier once anyone boarded
//   • no boarding on a cancelled trip; no names for an AZM-ID with no booking
// Real PostgreSQL (the sweep's relation filter, the real dispute) is covered
// in transit-wallet-pay.pg.test.js (W9-W11).
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messagingChannels', () => ({ notifyBookingConfirmed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ replayed: false }) }));
jest.mock('../services/escrowService', () => ({
    _refundEscrow: jest.fn().mockResolvedValue({ id: 'refunded' }),
    raiseDispute: jest.fn(),
}));

const escrowService = require('../services/escrowService');
const { makeDb, DAY } = require('./helpers/transitPrismaFake');
const {
    bookSeats, quoteSeats, completeTransitBooking, sweepHeldTransitPayouts, ID_CHECK_PAYOUT_HOLD_MS,
} = require('../services/transitBookingService');
const boarding = require('../services/transitBoardingService');

const HOUR = 60 * 60 * 1000;
const user = (db, id) => db.user.rows.find((u) => u.id === id);
const trip = (db) => db.transitTrip.rows[0];
const escrow = (db) => db.smartEscrow.rows[0];

// A paid passenger (10, AZM-000000010) on operator 20's trip, departing in
// 30 minutes: the boarding window is open.
async function paidPassenger({ departInMs = 30 * 60 * 1000 } = {}) {
    const db = makeDb();
    const seatIds = ['1A'];
    const q = await quoteSeats(db, { tripId: 'trip-1', customerId: 10, seatIds });
    const res = await bookSeats(db, {
        tripId: 'trip-1', customerId: 10, seatIds, payWith: 'WALLET', expectedTotalUsdc: q.totalUsdc.toFixed(6),
    });
    trip(db).departureAt = new Date(Date.now() + departInMs);
    const row = db.transitBooking.rows[0];
    row.scheduledAt = trip(db).departureAt;
    return { db, row, bookingId: res.booking.id };
}

const board = (db, bookingId, extra = {}) => boarding.boardByIdCheck(db, {
    bookingId, businessUserId: 20, azamanId: 'AZM-000000010', ...extra,
});
const depart = (db, agoMs = HOUR) => {
    trip(db).departureAt = new Date(Date.now() - agoMs);
    db.transitBooking.rows[0].scheduledAt = trip(db).departureAt;
};

describe('the manifest', () => {
    test('lists each passenger by seat with what staff check against an ID', async () => {
        const { db, bookingId } = await paidPassenger();
        const m = await boarding.buildTripManifest(db, { tripId: 'trip-1', businessUserId: 20 });
        expect(m.counts).toEqual({ booked: 1, boarded: 0, waiting: 1, noShow: 0 });
        expect(m.policy.allowIdCheck).toBe(true);
        expect(m.seats).toEqual([expect.objectContaining({ seatId: '1A', bookingId, azamanId: 'AZM-000000010', displayName: 'Ama' })]);
        const p = m.passengers[0];
        expect(p.passenger).toEqual(expect.objectContaining({
            azamanId: 'AZM-000000010', displayName: 'Ama', legalName: 'Ama Owusu',
            profilePictureUrl: 'https://img.test/ama.png', idVerified: true,
        }));
        expect(p.payment).toBe('HELD');
        expect(p.paid).toBe(true);
        expect(p.canBoardById).toBe(true);
    });

    test('is the trip business\'s only', async () => {
        const { db } = await paidPassenger();
        await expect(boarding.buildTripManifest(db, { tripId: 'trip-1', businessUserId: 99 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    test('offers no ID boarding before the window opens', async () => {
        const { db } = await paidPassenger({ departInMs: 3 * HOUR });
        const m = await boarding.buildTripManifest(db, { tripId: 'trip-1', businessUserId: 20 });
        expect(m.passengers[0].canBoardById).toBe(false);
    });
});

describe('AZM-ID search', () => {
    test('reads the ID however staff type it', () => {
        expect(boarding.normalizeAzamanId(' azm-000000010 ')).toBe('AZM-000000010');
        expect(boarding.normalizeAzamanId('AZM 10')).toBe('AZM-000000010');
        expect(boarding.normalizeAzamanId('10')).toBe('AZM-000000010');
        expect(boarding.normalizeAzamanId('BIZ-1')).toBe('BIZ-1');
        expect(boarding.normalizeAzamanId(null)).toBe('');
    });

    test('adds the passenger\'s transit bookings, and their names only with a booking here', async () => {
        const { db, bookingId } = await paidPassenger();
        const found = { customer: { id: 10, username: 'ama', azamanId: 'AZM-000000010' }, reservations: [] };
        const out = await boarding.enrichAzamanIdSearch(db, { businessUserId: 20, result: found });
        expect(out.transitBookings.map((b) => b.id)).toEqual([bookingId]);
        expect(out.customer.legalName).toBe('Ama Owusu');
        expect(out.boardingPolicy.allowIdCheck).toBe(true);

        db.transitBooking.rows[0].status = 'CANCELLED';
        const none = await boarding.enrichAzamanIdSearch(db, { businessUserId: 20, result: found });
        expect(none.transitBookings).toEqual([]);
        expect(none.customer.legalName).toBeNull();
        expect(none.customer.displayName).toBeNull();
        expect(none.customer.idVerified).toBe(false);
    });
});

describe('boarding by ID check', () => {
    test('boards a paid passenger and records how', async () => {
        const { db, row, bookingId } = await paidPassenger();
        const out = await board(db, bookingId, { azamanId: 'azm 10' });
        expect(out).toEqual(expect.objectContaining({ success: true, method: 'ID_CHECK', paid: true, payoutHoldHours: 24 }));
        expect(row.status).toBe('IN_PROGRESS');
        expect(row.metadata.boarding).toEqual(expect.objectContaining({ method: 'ID_CHECK', by: 20, azamanId: 'AZM-000000010' }));
        expect(escrow(db).status).toBe('FUNDED');
    });

    test('a wrong AZM-ID boards nothing', async () => {
        const { db, row, bookingId } = await paidPassenger();
        await expect(board(db, bookingId, { azamanId: 'AZM-000000020' }))
            .rejects.toMatchObject({ code: 'AZAMAN_ID_MISMATCH', httpStatus: 409 });
        await expect(board(db, bookingId, { azamanId: '' }))
            .rejects.toMatchObject({ code: 'AZAMAN_ID_REQUIRED' });
        expect(row.status).toBe('CONFIRMED');
    });

    test('only the trip\'s business can board (another\'s booking reads as missing)', async () => {
        const { db, row, bookingId } = await paidPassenger();
        await expect(board(db, bookingId, { businessUserId: 99 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        await expect(board(db, 'no-such-booking'))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(row.status).toBe('CONFIRMED');
    });

    test('never on a cancelled trip', async () => {
        const { db, row, bookingId } = await paidPassenger();
        trip(db).status = 'CANCELLED';
        await expect(board(db, bookingId)).rejects.toMatchObject({ code: 'TRIP_UNAVAILABLE', httpStatus: 409 });
        expect(row.status).toBe('CONFIRMED');
    });

    test('runs in one transaction with the escrow locked first', async () => {
        const { db, bookingId } = await paidPassenger();
        db.$executeRaw.mockClear();
        db.$transaction.mockClear();
        await board(db, bookingId);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(db.$executeRaw).toHaveBeenCalledTimes(1);
        expect(db.$executeRaw.mock.calls[0][0].join('?')).toContain('"SmartEscrow"');
    });

    test('only inside the boarding window', async () => {
        const early = await paidPassenger({ departInMs: 3 * HOUR });
        await expect(board(early.db, early.bookingId)).rejects.toMatchObject({ code: 'BOARDING_NOT_OPEN' });
        const late = await paidPassenger({ departInMs: -2 * HOUR });
        await expect(board(late.db, late.bookingId)).rejects.toMatchObject({ code: 'BOARDING_CLOSED' });
        expect(early.row.status).toBe('CONFIRMED');
        expect(late.row.status).toBe('CONFIRMED');
    });

    test('once', async () => {
        const { db, bookingId } = await paidPassenger();
        await board(db, bookingId);
        await expect(board(db, bookingId)).rejects.toMatchObject({ code: 'ALREADY_BOARDED' });
    });

    test('"QR only" refuses every ID check, and keeps the other settings', async () => {
        const { db, row, bookingId } = await paidPassenger();
        db.businessProfile.rows[0].businessMeta = { cuisine: 'local' };
        await boarding.setTransitBoardingPolicy(db, { businessUserId: 20, allowIdCheck: false });
        expect(db.businessProfile.rows[0].businessMeta.cuisine).toBe('local');
        expect(await boarding.getTransitBoardingPolicy(db, { businessUserId: 20 })).toEqual({ allowIdCheck: false });
        await expect(board(db, bookingId)).rejects.toMatchObject({ code: 'ID_CHECK_DISABLED' });
        expect(row.status).toBe('CONFIRMED');
        const m = await boarding.buildTripManifest(db, { tripId: 'trip-1', businessUserId: 20 });
        expect(m.passengers[0].canBoardById).toBe(false);
        await expect(boarding.setTransitBoardingPolicy(db, { businessUserId: 20, allowIdCheck: 'no' }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});

describe('the fare after an ID check', () => {
    // Boarded 30 minutes before departure; `after` is a clock one hour
    // after departure (time moves on; the departure does not).
    async function boardedAndDeparted() {
        const ctx = await paidPassenger();
        await board(ctx.db, ctx.bookingId);
        const dep = trip(ctx.db).departureAt.getTime();
        return { ...ctx, dep, after: dep + HOUR };
    }

    test('unconfirmed: the trip completes, the fare waits departure + 24h', async () => {
        const { db, row, bookingId, dep, after } = await boardedAndDeparted();
        const out = await completeTransitBooking(db, { bookingId, now: after });
        expect(out.booking.status).toBe('COMPLETED');
        expect(out.release).toBeNull();
        const until = dep + ID_CHECK_PAYOUT_HOLD_MS;
        expect(out.payoutHeld.until.getTime()).toBe(until);
        expect(new Date(row.metadata.payout.heldUntil).getTime()).toBe(until);
        expect(row.metadata.boarding.method).toBe('ID_CHECK'); // kept
        expect(escrow(db).status).toBe('FUNDED');
        expect(user(db, 20).availableBalance).toBe(0);
    });

    test('the sweep releases it after the hold, not before', async () => {
        const { db, row, bookingId, dep, after } = await boardedAndDeparted();
        await completeTransitBooking(db, { bookingId, now: after });
        const early = await sweepHeldTransitPayouts(db, { now: dep + ID_CHECK_PAYOUT_HOLD_MS - 60 * 1000 });
        expect(early.released).toBe(0);
        expect(escrow(db).status).toBe('FUNDED');

        const out = await sweepHeldTransitPayouts(db, { now: dep + ID_CHECK_PAYOUT_HOLD_MS });
        expect(out.released).toBe(1);
        expect(escrow(db).status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBe(2);
        expect(row.metadata.payout.releasedAt).toBeTruthy();
        // And never twice.
        const again = await sweepHeldTransitPayouts(db, { now: dep + 2 * ID_CHECK_PAYOUT_HOLD_MS });
        expect(again.released).toBe(0);
        expect(user(db, 20).availableBalance).toBe(2);
    });

    test('a reported boarding is never released by the sweep', async () => {
        const { db, bookingId, dep, after } = await boardedAndDeparted();
        await completeTransitBooking(db, { bookingId, now: after });
        escrowService.raiseDispute.mockImplementationOnce(async (_p, { escrowId }) => {
            db.smartEscrow.rows.find((e) => e.id === escrowId).status = 'DISPUTED';
            return { dispute: { id: 'd-1' } };
        });
        const rep = await boarding.reportIdCheckBoarding(db, { bookingId, customerId: 10, reason: 'I was at home' });
        expect(rep).toMatchObject({ success: true, alreadyReported: false, disputeId: 'd-1', bookingRef: expect.any(String) });
        expect(escrowService.raiseDispute).toHaveBeenCalledWith(db, expect.objectContaining({
            escrowId: escrow(db).id, raisedById: 10,
            reason: expect.stringContaining('I was at home'),
        }));
        const out = await sweepHeldTransitPayouts(db, { now: dep + 2 * ID_CHECK_PAYOUT_HOLD_MS });
        expect(out.released).toBe(0);
        expect(user(db, 20).availableBalance).toBe(0);
    });

    test('reporting twice, or after the payout, answers plainly', async () => {
        const { db, bookingId } = await boardedAndDeparted();
        escrowService.raiseDispute.mockRejectedValueOnce(new Error('ESCROW_ALREADY_DISPUTED'));
        await expect(boarding.reportIdCheckBoarding(db, { bookingId, customerId: 10 }))
            .resolves.toEqual({ success: true, alreadyReported: true, disputeId: null });
        escrowService.raiseDispute.mockRejectedValueOnce(new Error('Cannot dispute an escrow in status SETTLED.'));
        await expect(boarding.reportIdCheckBoarding(db, { bookingId, customerId: 10 }))
            .rejects.toMatchObject({ code: 'ALREADY_PAID_OUT', httpStatus: 409 });
        // Someone else's booking reads as missing.
        await expect(boarding.reportIdCheckBoarding(db, { bookingId, customerId: 20 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('confirmed after completion: released at once', async () => {
        const { db, row, bookingId, after } = await boardedAndDeparted();
        await completeTransitBooking(db, { bookingId, now: after });
        const out = await boarding.confirmIdCheckBoarding(db, { bookingId, customerId: 10, now: after + HOUR });
        expect(out.release).toEqual(expect.objectContaining({ amountUsdc: 2 }));
        expect(row.metadata.boarding.passengerConfirmedAt).toBeTruthy();
        expect(escrow(db).status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBe(2);
        // Confirming again changes nothing.
        const again = await boarding.confirmIdCheckBoarding(db, { bookingId, customerId: 10, now: after + HOUR });
        expect(again.release).toBeNull();
        expect(user(db, 20).availableBalance).toBe(2);
    });

    test('confirmed before completion: completion releases it', async () => {
        const ctx = await paidPassenger();
        await board(ctx.db, ctx.bookingId);
        const c = await boarding.confirmIdCheckBoarding(ctx.db, { bookingId: ctx.bookingId, customerId: 10 });
        expect(c.release).toBeNull();
        const out = await completeTransitBooking(ctx.db, {
            bookingId: ctx.bookingId, now: trip(ctx.db).departureAt.getTime() + HOUR,
        });
        expect(out.payoutHeld).toBeNull();
        expect(out.release).toEqual(expect.objectContaining({ amountUsdc: 2 }));
        expect(user(ctx.db, 20).availableBalance).toBe(2);
    });

    test('only the passenger confirms, only an ID-check boarding', async () => {
        const { db, bookingId, row } = await boardedAndDeparted();
        await expect(boarding.confirmIdCheckBoarding(db, { bookingId, customerId: 20 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
        row.metadata = { boarding: { method: 'QR_TOKEN' } };
        await expect(boarding.confirmIdCheckBoarding(db, { bookingId, customerId: 10 }))
            .rejects.toMatchObject({ code: 'NOT_ID_CHECKED' });
    });

    test('a QR-boarded fare is still released at completion', async () => {
        const { db, row, bookingId } = await paidPassenger();
        row.status = 'IN_PROGRESS';
        row.metadata = { boarding: { method: 'QR_TOKEN' } };
        depart(db);
        const out = await completeTransitBooking(db, { bookingId });
        expect(out.payoutHeld).toBeNull();
        expect(user(db, 20).availableBalance).toBe(2);
    });

    // Expiry comes days after the trip: the worker runs at a later clock.
    const runExpiryAt = async (db, at) => {
        escrow(db).expiresAt = new Date(at.getTime() - 1000);
        const EscrowExpiryWorker = require('../workers/escrowExpiryWorker');
        const Worker = EscrowExpiryWorker.EscrowExpiryWorker || EscrowExpiryWorker;
        await new Worker(db, null, null, {})._expireInactiveFunded(at);
    };

    test('escrow expiry releases a held ID-check fare instead of refunding', async () => {
        escrowService._refundEscrow.mockClear();
        const { db, bookingId, after } = await boardedAndDeparted();
        await completeTransitBooking(db, { bookingId, now: after });
        await runExpiryAt(db, new Date(Date.now() + 8 * DAY));
        expect(escrowService._refundEscrow).not.toHaveBeenCalled();
        expect(escrow(db).status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBe(2);
    });

    test('escrow expiry completes and releases an ID-checked trip the operator never completed', async () => {
        escrowService._refundEscrow.mockClear();
        const { db, row, bookingId } = await paidPassenger();
        await board(db, bookingId);
        await runExpiryAt(db, new Date(Date.now() + 8 * DAY));
        expect(escrowService._refundEscrow).not.toHaveBeenCalled();
        expect(row.status).toBe('COMPLETED');
        expect(user(db, 20).availableBalance).toBe(2);
    });
});

describe('the hold is fixed at boarding', () => {
    const ctrlM = require('../controllers/marketplaceController');
    const patchTrip = async (db, body) => {
        let status = null; let payload = null;
        await ctrlM.updateTransitTrip({
            app: { get: () => db }, user: { id: 20 }, params: { id: 'trip-1' }, body,
        }, {
            status(c) { status = c; return this; },
            json(p) { payload = p; return this; },
        });
        return { status, payload };
    };

    test('backdating the departure after an ID check pays nothing early', async () => {
        const { db, row, bookingId } = await paidPassenger(); // departs in 30 min
        await board(db, bookingId);
        const boardedAt = Date.now();
        // The departure written straight to the row 25h into the past (the
        // API refuses this; the hold must hold even if it were not).
        depart(db, 25 * HOUR);
        const out = await completeTransitBooking(db, { bookingId });
        expect(out.release).toBeNull();
        expect(out.payoutHeld.until.getTime()).toBeGreaterThanOrEqual(boardedAt + ID_CHECK_PAYOUT_HOLD_MS);
        expect(user(db, 20).availableBalance).toBe(0);
        expect((await sweepHeldTransitPayouts(db, { now: Date.now() + HOUR })).released).toBe(0);
        expect(escrow(db).status).toBe('FUNDED');
        // After the hold fixed at boarding, it is released.
        const later = await sweepHeldTransitPayouts(db, { now: Date.now() + ID_CHECK_PAYOUT_HOLD_MS + HOUR });
        expect(later.released).toBe(1);
        expect(row.metadata.boarding.holdUntil).toBeTruthy();
    });

    test('a departure cannot be moved into the past', async () => {
        const db = makeDb();
        const out = await patchTrip(db, { departureAt: new Date(Date.now() - 2 * HOUR).toISOString() });
        expect(out.status).toBe(400);
        expect(out.payload.code).toBe('DEPARTURE_IN_PAST');
        const bad = await patchTrip(db, { departureAt: 'not a date' });
        expect(bad.payload.code).toBe('DEPARTURE_INVALID');
    });

    test('once anyone is on board, the departure only moves later', async () => {
        const { db, bookingId } = await paidPassenger({ departInMs: 50 * 60 * 1000 });
        await board(db, bookingId);
        const earlier = await patchTrip(db, { departureAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() });
        expect(earlier.status).toBe(409);
        expect(earlier.payload.code).toBe('TRIP_UNDERWAY');
        const later = await patchTrip(db, { departureAt: new Date(Date.now() + 3 * HOUR).toISOString() });
        expect(later.status).toBe(200);
        // Re-sending the unchanged departure (a full-form save) is fine.
        const same = await patchTrip(db, { departureAt: trip(db).departureAt.toISOString(), routeName: 'Express' });
        expect(same.status).toBe(200);
    });
});

describe('controllers and routes', () => {
    const ctrl = require('../controllers/transitController');
    const call = async (fn, req) => {
        let status = null; let payload = null;
        await fn(req, {
            status(c) { status = c; return this; },
            json(p) { payload = p; return this; },
        });
        return { status, payload };
    };

    test('board-by-id answers 200 and tells the passenger', async () => {
        const { db, bookingId } = await paidPassenger();
        const sendNotification = jest.fn().mockResolvedValue(undefined);
        const emit = jest.fn();
        const settings = { prisma: db, notificationService: { sendNotification }, socketio: { to: () => ({ emit }) } };
        const out = await call(ctrl.boardById, {
            app: { get: (k) => settings[k] }, user: { id: 20 }, params: { id: bookingId },
            body: { azamanId: 'AZM-000000010' },
        });
        expect(out.status).toBe(200);
        expect(out.payload.method).toBe('ID_CHECK');
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
            userId: 10,
            title: 'You were boarded by ID check',
            body: expect.stringContaining('Kofi Express'),
            actionPayload: { action: 'OPEN_TRANSIT_TRIPS', bookingId },
        }));
        expect(emit).toHaveBeenCalledWith('transit_booking_update', expect.objectContaining({ id: bookingId }));
    });

    test('a failed notice never undoes or hides the boarding', async () => {
        const { db, row, bookingId } = await paidPassenger();
        const settings = { prisma: db, notificationService: { sendNotification: jest.fn().mockRejectedValue(new Error('push down')) } };
        const out = await call(ctrl.boardById, {
            app: { get: (k) => settings[k] }, user: { id: 20 }, params: { id: bookingId },
            body: { azamanId: 'AZM-000000010' },
        });
        expect(out.status).toBe(200);
        expect(row.status).toBe('IN_PROGRESS');
    });

    test('refusals keep their code and status', async () => {
        const { db, bookingId } = await paidPassenger();
        const out = await call(ctrl.boardById, {
            app: { get: () => db }, user: { id: 20 }, params: { id: bookingId }, body: { azamanId: 'AZM-000000099' },
        });
        expect(out.status).toBe(409);
        expect(out.payload).toEqual(expect.objectContaining({ success: false, code: 'AZAMAN_ID_MISMATCH' }));
    });

    test('a report tells the operator, and refusals stay 409', async () => {
        const { db, bookingId } = await paidPassenger();
        await board(db, bookingId);
        escrowService.raiseDispute.mockResolvedValueOnce({ dispute: { id: 'd-9' } });
        const sendNotification = jest.fn().mockResolvedValue(undefined);
        const settings = { prisma: db, notificationService: { sendNotification } };
        const out = await call(ctrl.reportBoarding, {
            app: { get: (k) => settings[k] }, user: { id: 10 }, params: { id: bookingId }, body: { reason: 'Not me' },
        });
        expect(out.status).toBe(200);
        expect(out.payload.operatorUserId).toBeUndefined();
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({
            userId: 20, title: 'A passenger reported a boarding',
            actionPayload: { action: 'OPEN_DISPUTE', disputeId: 'd-9' },
        }));

        escrowService.raiseDispute.mockRejectedValueOnce(new Error('Escrow not found.'));
        const refused = await call(ctrl.reportBoarding, {
            app: { get: () => db }, user: { id: 10 }, params: { id: bookingId }, body: {},
        });
        expect(refused.status).toBe(409);
        expect(refused.payload.code).toBe('NOT_REPORTABLE');
    });

    test('the payout sweep runs even when a no-show sweep fails', async () => {
        const worker = require('../workers/reservationNoShowWorker');
        const { db, bookingId } = await paidPassenger();
        await board(db, bookingId);
        depart(db, 30 * HOUR);
        await completeTransitBooking(db, { bookingId, now: Date.now() + ID_CHECK_PAYOUT_HOLD_MS });
        db.reservation = { findMany: jest.fn().mockRejectedValue(new Error('reservations down')) };
        // Real time has not passed the hold fixed at boarding, so nothing is
        // released, but the payout sweep did run before the error surfaced.
        const spy = jest.spyOn(require('../services/transitBookingService'), 'sweepHeldTransitPayouts');
        await expect(worker.sweepAll(db)).rejects.toThrow('reservations down');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('the passenger sees where their fare is', async () => {
        const { db } = await paidPassenger();
        const out = await call(ctrl.listBookings, { app: { get: () => db }, user: { id: 10 }, query: {} });
        expect(out.status).toBe(200);
        expect(out.payload.bookings[0].payment).toBe('HELD');
    });

    test('every boarding route is authenticated', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../routes/transitRoutes.js'), 'utf-8');
        for (const r of [
            "router.get('/trips/:id/manifest', protect,",
            "router.post('/bookings/:id/board-by-id', protect,",
            "router.post('/bookings/:id/boarding/confirm', protect,",
            "router.post('/bookings/:id/boarding/report', protect,",
            "router.get('/boarding-policy', protect,",
            "router.put('/boarding-policy', protect,",
        ]) expect(src).toContain(r);
    });

    test('the hourly sweep includes the held payouts', async () => {
        const worker = require('../workers/reservationNoShowWorker');
        const { db } = await paidPassenger();
        db.reservation = { findMany: jest.fn().mockResolvedValue([]) };
        const out = await worker.sweepAll(db);
        expect(out.payouts).toEqual(expect.objectContaining({ released: 0 }));
    });
});
