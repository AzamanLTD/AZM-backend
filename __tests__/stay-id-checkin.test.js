// =============================================================================
// Checking a hotel guest in by ID check (services/stayCheckInService):
//   • only the business's own reservation, only the guest's AZM-ID, only
//     CONFIRMED, only inside the check-in window, only if the business
//     allows ID checks;
//   • a paid stay is checked in but its money stays held: nothing is
//     released until the guest confirms, or the report window passes;
//   • the guest's "Not me" opens a dispute; a reported stay is not paid out;
//   • the lifecycle refuses a by-hand check-in of a paid stay (QR or ID check).
// Real money movement (_releaseBookingEscrowTx) has its own suites.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/bookingEscrowService', () => {
    const actual = jest.requireActual('../services/bookingEscrowService');
    return {
        ...actual,
        _releaseBookingEscrowTx: jest.fn(async (tx, { escrowId }) => {
            const e = tx.smartEscrow.rows.find((r) => r.id === escrowId);
            e.status = 'SETTLED';
            return e;
        }),
    };
});
jest.mock('../services/escrowService', () => ({
    raiseDispute: jest.fn(async (db, { escrowId }) => {
        const e = db.smartEscrow.rows.find((r) => r.id === escrowId);
        if (e.status === 'DISPUTED') throw new Error('ESCROW_ALREADY_DISPUTED');
        e.status = 'DISPUTED';
        return { dispute: { id: 'd1' } };
    }),
}));

const { table } = require('./helpers/transitPrismaFake');
const { _releaseBookingEscrowTx } = require('../services/bookingEscrowService');
const stay = require('../services/stayCheckInService');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-12-05T15:00:00Z');

function makeDb({ allowIdCheck, escrowStatus = 'FUNDED', status = 'CONFIRMED', start = '2026-12-05T00:00:00Z' } = {}) {
    const db = {
        businessProfile: table([{ id: 'bp-h', userId: 20, businessName: 'Labadi Beach Hotel', businessMeta: allowIdCheck === undefined ? {} : { stayCheckIn: { allowIdCheck } } }]),
        user: table([{ id: 10, azamanId: 'AZM-000000010' }]),
        smartEscrow: table(escrowStatus ? [{ id: 'esc-1', status: escrowStatus }] : []),
        reservation: table([{
            id: 'r1', reservationRef: 'RES-1', businessProfileId: 'bp-h', customerId: 10, status,
            escrowId: escrowStatus ? 'esc-1' : null,
            startDatetime: new Date(start), endDatetime: new Date(Date.parse(start) + 2 * DAY),
            metadata: { paidStay: !!escrowStatus },
        }]),
        $executeRaw: jest.fn(async () => 1),
    };
    // include: { businessProfile: true }
    const find = db.reservation.findUnique;
    db.reservation.findUnique = jest.fn(async (args) => {
        const r = await find(args);
        if (r && args.include && args.include.businessProfile) {
            return { ...r, businessProfile: db.businessProfile.rows.find((b) => b.id === r.businessProfileId) };
        }
        return r;
    });
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
}
const res = (db) => db.reservation.rows[0];
const checkIn = (db, extra = {}) => stay.checkInByIdCheck(db, {
    reservationId: 'r1', businessProfileId: 'bp-h', actorUserId: 31, azamanId: 'azm 10', now: NOW, ...extra,
});

beforeEach(() => jest.clearAllMocks());

describe('checking a guest in by ID check', () => {
    test('a paid stay is checked in, and its money stays held', async () => {
        const db = makeDb();
        const out = await checkIn(db);
        expect(out.paymentHeld).toBe(true);
        expect(res(db).status).toBe('CHECKED_IN');
        expect(res(db).metadata.checkIn).toEqual(expect.objectContaining({ method: 'ID_CHECK', by: 31, azamanId: 'AZM-000000010' }));
        expect(new Date(res(db).metadata.checkIn.holdUntil).getTime()).toBe(NOW + stay.STAY_ID_CHECK_HOLD_MS);
        expect(db.smartEscrow.rows[0].status).toBe('FUNDED');
        expect(_releaseBookingEscrowTx).not.toHaveBeenCalled();
    });

    test.each([
        ['another business', { businessProfileId: 'bp-other' }, {}, 'NOT_FOUND'],
        ['a wrong AZM-ID', { azamanId: 'AZM-000000099' }, {}, 'AZAMAN_ID_MISMATCH'],
        ['ID checks turned off', {}, { allowIdCheck: false }, 'ID_CHECK_DISABLED'],
        ['not confirmed', {}, { status: 'PENDING' }, 'NOT_CHECKIN_READY'],
        ['already checked in', {}, { status: 'CHECKED_IN' }, 'ALREADY_CHECKED_IN'],
        ['before the window', {}, { start: '2026-12-08T00:00:00Z' }, 'CHECKIN_NOT_OPEN'],
        ['a disputed payment', {}, { escrowStatus: 'DISPUTED' }, 'ESCROW_IN_DISPUTE'],
    ])('refused for %s, with nothing changed', async (_label, args, dbOpts, code) => {
        const db = makeDb(dbOpts);
        const before = JSON.stringify(db.reservation.rows);
        await expect(checkIn(db, args)).rejects.toMatchObject({ code });
        expect(JSON.stringify(db.reservation.rows)).toBe(before);
    });

    test('a stay not paid in the app just checks in', async () => {
        const db = makeDb({ escrowStatus: null });
        const out = await checkIn(db);
        expect(out.paymentHeld).toBe(false);
        expect(res(db).status).toBe('CHECKED_IN');
        expect(res(db).metadata.checkIn.holdUntil).toBeUndefined();
    });
});

describe("the guest's answer", () => {
    test('"That was me" pays the hotel now', async () => {
        const db = makeDb();
        await checkIn(db);
        const out = await stay.confirmStayCheckIn(db, { reservationId: 'r1', customerId: 10, now: NOW + 1000 });
        expect(out.released).toBe(true);
        expect(db.smartEscrow.rows[0].status).toBe('SETTLED');
        expect(res(db).metadata.checkIn.guestConfirmedAt).toBeTruthy();
        // A second confirm pays nothing more.
        const again = await stay.confirmStayCheckIn(db, { reservationId: 'r1', customerId: 10, now: NOW + 2000 });
        expect(again.released).toBe(false);
        expect(_releaseBookingEscrowTx).toHaveBeenCalledTimes(1);
    });

    test('only the guest can answer', async () => {
        const db = makeDb();
        await checkIn(db);
        await expect(stay.confirmStayCheckIn(db, { reservationId: 'r1', customerId: 99 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(stay.reportStayCheckIn(db, { reservationId: 'r1', customerId: 99 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('"Not me" opens a dispute; the sweep never pays a reported stay', async () => {
        const db = makeDb();
        await checkIn(db);
        const out = await stay.reportStayCheckIn(db, { reservationId: 'r1', customerId: 10, reason: 'I am in Kumasi' });
        expect(out.disputeId).toBe('d1');
        expect(db.smartEscrow.rows[0].status).toBe('DISPUTED');
        expect((await stay.reportStayCheckIn(db, { reservationId: 'r1', customerId: 10 })).alreadyReported).toBe(true);
        const swept = await stay.sweepHeldStayPayouts(db, { now: NOW + stay.STAY_ID_CHECK_HOLD_MS + 1000 });
        expect(swept.released).toBe(0);
        expect(db.smartEscrow.rows[0].status).toBe('DISPUTED');
    });
});

describe('the sweep', () => {
    test('pays the hotel once the report window has passed, once', async () => {
        const db = makeDb();
        await checkIn(db);
        expect((await stay.sweepHeldStayPayouts(db, { now: NOW + 1000 })).released).toBe(0); // still in the window
        const later = NOW + stay.STAY_ID_CHECK_HOLD_MS + 1000;
        expect((await stay.sweepHeldStayPayouts(db, { now: later })).released).toBe(1);
        expect(db.smartEscrow.rows[0].status).toBe('SETTLED');
        expect((await stay.sweepHeldStayPayouts(db, { now: later + 1000 })).released).toBe(0);
        expect(_releaseBookingEscrowTx).toHaveBeenCalledTimes(1);
    });
});

describe('the policy', () => {
    test('defaults to allowed; the owner can turn it off', async () => {
        const db = makeDb();
        expect(stay.stayCheckInPolicy(db.businessProfile.rows[0])).toEqual({ allowIdCheck: true });
        await stay.setStayCheckInPolicy(db, { businessProfileId: 'bp-h', allowIdCheck: false });
        expect(stay.stayCheckInPolicy(db.businessProfile.rows[0])).toEqual({ allowIdCheck: false });
        await expect(stay.setStayCheckInPolicy(db, { businessProfileId: 'bp-h', allowIdCheck: 'no' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});
