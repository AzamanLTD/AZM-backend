// =============================================================================
// GET /api/marketplace/business/:bizId/stay-quote — read-only.
//
// For dates + guests, every room's exact total (the reservation's own
// per-night pricing: override > weekend > base) and whether it can be
// booked, with the reason when not: unavailable, too small, blocked, already
// booked, no price. In-memory Prisma (helpers/transitPrismaFake).
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { table } = require('./helpers/transitPrismaFake');
const ctrl = require('../controllers/hotelMarketplaceController');

const day = (s) => new Date(`${s}T00:00:00.000Z`);
// A Friday-to-Monday stay a year out. The pricing treats the nights dated
// Saturday and Sunday (UTC) as weekend nights.
const IN = '2027-12-03'; // Friday
const OUT = '2027-12-06'; // Monday: nights Fri 3, Sat 4, Sun 5

function makeDb() {
    return {
        businessProfile: table([
            { id: 'bp-h', bizId: 'BIZ-H', category: 'HOSPITALITY', isSuspended: false, isPausedByOwner: false },
            { id: 'bp-r', bizId: 'BIZ-R', category: 'FOOD_BEVERAGE', isSuspended: false },
        ]),
        hotelRoom: table([
            { id: 'r1', businessProfileId: 'bp-h', roomNumber: '101', roomType: 'DELUXE', floor: 1, capacity: 2, status: 'AVAILABLE', basePriceUsdc: 50, weekendPriceUsdc: 70 },
            { id: 'r2', businessProfileId: 'bp-h', roomNumber: '102', roomType: 'STANDARD', floor: 1, capacity: 1, status: 'AVAILABLE', basePriceUsdc: 30, weekendPriceUsdc: null },
            { id: 'r3', businessProfileId: 'bp-h', roomNumber: '201', roomType: 'DELUXE', floor: 2, capacity: 4, status: 'MAINTENANCE', basePriceUsdc: 80, weekendPriceUsdc: null },
            { id: 'r4', businessProfileId: 'bp-h', roomNumber: '202', roomType: 'DELUXE', floor: 2, capacity: 3, status: 'AVAILABLE', basePriceUsdc: 60, weekendPriceUsdc: null },
            { id: 'r5', businessProfileId: 'bp-h', roomNumber: '203', roomType: 'SUITE', floor: 2, capacity: 3, status: 'AVAILABLE', basePriceUsdc: 90, weekendPriceUsdc: null },
        ]),
        hotelRoomBlock: table([
            { id: 'b1', roomId: 'r4', startDate: day('2027-12-05'), endDate: day('2027-12-07'), reason: 'Painting' },
        ]),
        reservation: table([
            { id: 'res-1', businessProfileId: 'bp-h', serviceItemId: 'r5', status: 'CONFIRMED', startDatetime: day('2027-12-02'), endDatetime: day('2027-12-04') },
            { id: 'res-2', businessProfileId: 'bp-h', serviceItemId: 'r1', status: 'CANCELLED_CUSTOMER', startDatetime: day(IN), endDatetime: day(OUT) },
        ]),
        // The quote prices the Azaman fee on a stay paid in the app.
        globalSettings: table([{ id: 1, smartEscrowFeePct: 0.01 }]),
        hotelRateOverride: table([
            { id: 'o1', businessProfileId: 'bp-h', roomId: null, roomType: 'DELUXE', date: day('2027-12-03'), priceUsdc: 99 },
        ]),
    };
}

const call = async (db, { bizId = 'BIZ-H', checkIn = IN, checkOut = OUT, guests } = {}) => {
    let status = null; let body = null;
    await ctrl.getStayQuote({
        app: { get: () => db },
        params: { bizId },
        query: { checkIn, checkOut, ...(guests != null ? { guests: String(guests) } : {}) },
    }, { status(c) { status = c; return this; }, json(b) { body = b; return this; } });
    return { status, body };
};

describe('stay quote', () => {
    test('each room: the exact total and why it can or cannot be booked', async () => {
        const out = await call(makeDb(), { guests: 2 });
        expect(out.status).toBe(200);
        // Paid in the app, held until check-in.
        expect(out.body).toEqual(expect.objectContaining({ nights: 3, guests: 2, payAt: 'APP', heldUntil: 'CHECK_IN', checkIn: IN, checkOut: OUT }));
        const byId = Object.fromEntries(out.body.rooms.map((r) => [r.roomId, r]));
        // r1: override 99 (Fri, type-wide) + weekend 70 (Sat) + weekend 70 (Sun)
        expect(byId.r1).toEqual(expect.objectContaining({ bookable: true, reason: null, totalUsdc: 239, feeUsdc: 2.39, payTotalUsdc: 241.39 }));
        expect(byId.r1.nightly.map((n) => n.source)).toEqual(['OVERRIDE', 'WEEKEND', 'WEEKEND']);
        expect(byId.r2).toEqual(expect.objectContaining({ bookable: false, reason: 'TOO_SMALL' }));
        expect(byId.r3).toEqual(expect.objectContaining({ bookable: false, reason: 'ROOM_UNAVAILABLE' }));
        expect(byId.r4).toEqual(expect.objectContaining({ bookable: false, reason: 'BLOCKED' }));
        expect(byId.r5).toEqual(expect.objectContaining({ bookable: false, reason: 'BOOKED' }));
    });

    test('a cancelled reservation does not hold the room', async () => {
        const out = await call(makeDb(), { guests: 1 });
        expect(out.body.rooms.find((r) => r.roomId === 'r1').bookable).toBe(true);
    });

    test('dates must be real, in order, not past, and at most 60 nights', async () => {
        expect((await call(makeDb(), { checkOut: IN })).body.code).toBe('DATES_INVALID');
        expect((await call(makeDb(), { checkIn: 'soon' })).body.code).toBe('DATES_INVALID');
        expect((await call(makeDb(), { checkIn: '2020-01-01', checkOut: '2020-01-03' })).body.code).toBe('DATES_PAST');
        expect((await call(makeDb(), { checkOut: '2028-03-01' })).body.code).toBe('STAY_TOO_LONG');
    });

    test('only a hotel, and not a suspended one', async () => {
        expect((await call(makeDb(), { bizId: 'BIZ-R' })).status).toBe(409);
        expect((await call(makeDb(), { bizId: 'BIZ-NONE' })).status).toBe(404);
        const db = makeDb();
        db.businessProfile.rows[0].isSuspended = true;
        expect((await call(db)).status).toBe(404);
    });

    test('the route is public and read-only (GET)', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/marketplaceRoutes.js'), 'utf-8');
        expect(src).toContain("router.get('/business/:bizId/stay-quote', hotelCtrl.getStayQuote)");
    });
});
