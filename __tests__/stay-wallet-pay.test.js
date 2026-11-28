// =============================================================================
// A hotel stay paid from the wallet, held until check-in.
//
// In-memory Prisma (helpers/transitPrismaFake), the real stay payment,
// booking-escrow and reservation-lifecycle services, the ledger mocked:
//   • paying books, pays and confirms in one go: price + fee debited, price
//     held, the hotel not paid yet; a retry with the same key charges nothing
//   • the approved total must match the server's per-night price
//   • a room taken, closed or too small, or your own hotel: refused, nothing
//     charged
//   • the guest's QR check-in releases the price to the hotel
//   • staff cannot check a paid stay in by hand (QR_CHECKIN_REQUIRED)
//   • the hotel declining or cancelling, the guest cancelling, and a stay
//     that ends with no check-in all refund the price
//   • a paid stay's no-show terms cannot change afterwards
//   • the escrow outlives the stay; the quote charges what the payment does
// Real PostgreSQL (rollback, the room lock) is stay-wallet-pay.pg.test.js.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ replayed: false }) }));
jest.mock('../services/messagingChannels', () => ({ notifyBookingConfirmed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/webhookEmitter', () => ({ emitWebhookEvent: jest.fn() }));

const { table } = require('./helpers/transitPrismaFake');
const stay = require('../services/stayPaymentService');
const lifecycle = require('../services/reservationLifecycleService');

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);
const utcDay = (offsetDays) => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offsetDays));
};
// A two-night stay a week out, on weekdays only if possible: priced by base
// rate unless the dates fall on a weekend, so expected totals are computed by
// the same quote the guest would see.
const IN = utcDay(7);
const OUT = utcDay(9);

function makeDb({ balance = 500 } = {}) {
    const db = {
        businessProfile: table([
            { id: 'bp-h', bizId: 'BIZ-H', userId: 20, businessName: 'Labadi Beach Hotel', category: 'HOSPITALITY', isSuspended: false, isPausedByOwner: false },
        ]),
        hotelRoom: table([
            { id: 'r1', businessProfileId: 'bp-h', locationId: null, roomNumber: '101', roomType: 'DELUXE', capacity: 2, status: 'AVAILABLE', basePriceUsdc: 50, weekendPriceUsdc: null },
            { id: 'r2', businessProfileId: 'bp-h', locationId: null, roomNumber: '102', roomType: 'DELUXE', capacity: 1, status: 'AVAILABLE', basePriceUsdc: 40, weekendPriceUsdc: null },
        ]),
        hotelRoomBlock: table([]),
        hotelRateOverride: table([]),
        reservation: table([]),
        user: table([
            { id: 10, availableBalance: balance, escrowLockedBalance: 0, disputeEscrowBalance: 0, banStatus: 'ACTIVE' },
            { id: 20, availableBalance: 0, escrowLockedBalance: 0, disputeEscrowBalance: 0, banStatus: 'ACTIVE' },
        ]),
        ticket: table([]),
        smartEscrow: table([]),
        globalSettings: table([{ id: 1, smartEscrowFeePct: 0.01, escrowFundedExpiryDays: 30 }]),
        systemProfitFees: table([{ id: 1, balance: 0 }]),
        transactionHistory: table([]),
        adminProfitLog: table([]),
        financialOperation: table([{ id: 'op-1', status: 'IN_PROGRESS' }]),
        $executeRaw: jest.fn(async () => 1),
    };
    // The lifecycle reads reservation.escrow / .businessProfile (Prisma
    // include): resolve them live on every reservation row.
    const decorate = (r) => {
        if (!r || Object.prototype.hasOwnProperty.call(r, 'escrow')) return r;
        Object.defineProperty(r, 'escrow', { get: () => db.smartEscrow.rows.find((e) => e.id === r.escrowId) || null, enumerable: false });
        Object.defineProperty(r, 'businessProfile', { get: () => db.businessProfile.rows.find((b) => b.id === r.businessProfileId) || null, enumerable: false });
        return r;
    };
    const create = db.reservation.create;
    db.reservation.create = jest.fn(async (args) => decorate(await create(args)));
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
}
const user = (db, id) => db.user.rows.find((u) => u.id === id);
const escrow = (db) => db.smartEscrow.rows[0];
const reservation = (db) => db.reservation.rows[0];

async function quoteTotal(db, roomId = 'r1', guests = 2) {
    const p = await stay.priceStay(db, { bizId: 'BIZ-H', roomId, checkInDate: iso(IN), checkOutDate: iso(OUT), partySize: guests });
    return p;
}
async function payStay(db, extra = {}) {
    const p = await quoteTotal(db, extra.roomId || 'r1', extra.partySize || 2);
    return stay.bookPaidStay(db, {
        bizId: 'BIZ-H', roomId: 'r1', customerId: 10, checkInDate: iso(IN), checkOutDate: iso(OUT), partySize: 2,
        expectedTotalUsdc: p.totalUsdc.toFixed(6), clientRequestKey: 'key-1', ...extra,
    });
}

describe('paying for a stay', () => {
    test('books, pays and confirms: the price is held, the hotel not paid yet', async () => {
        const db = makeDb();
        const p = await quoteTotal(db);
        const out = await payStay(db, { financialOperation: { id: 'op-1' } });
        expect(out.reservation.status).toBe('CONFIRMED');
        expect(out.payment).toEqual(expect.objectContaining({
            method: 'WALLET', amountUsdc: p.amountUsdc, feeUsdc: p.feeUsdc, totalUsdc: p.totalUsdc, heldUntil: 'CHECK_IN',
        }));
        expect(escrow(db).status).toBe('FUNDED');
        expect(user(db, 10).availableBalance).toBeCloseTo(500 - p.totalUsdc, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(p.amountUsdc, 9);
        expect(user(db, 20).availableBalance).toBe(0);
        expect(reservation(db).partySize).toBe(2);
        expect(db.financialOperation.rows[0].status).toBe('COMMITTED');
        expect(db.$executeRaw).toHaveBeenCalled(); // the room row lock
    });

    test('a retry with the same key charges nothing more; a different stay under it is refused', async () => {
        const db = makeDb();
        const first = await payStay(db);
        const again = await payStay(db);
        expect(again.replayed).toBe(true);
        expect(again.reservation.id).toBe(first.reservation.id);
        expect(again.payment.escrowId).toBe(first.payment.escrowId);
        expect(db.smartEscrow.rows).toHaveLength(1);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(first.payment.amountUsdc, 9);
        await expect(payStay(db, { partySize: 1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 409 });
    });

    test('the approved total must match the server price exactly', async () => {
        const db = makeDb();
        await expect(payStay(db, { expectedTotalUsdc: '1.000000' })).rejects.toMatchObject({ code: 'PRICE_CHANGED', httpStatus: 409 });
        await expect(payStay(db, { expectedTotalUsdc: null })).rejects.toMatchObject({ code: 'EXPECTED_TOTAL_REQUIRED' });
        await expect(payStay(db, { expectedTotalUsdc: '1e2' })).rejects.toMatchObject({ code: 'EXPECTED_TOTAL_INVALID' });
        expect(db.reservation.rows).toHaveLength(0);
        expect(user(db, 10).availableBalance).toBe(500);
    });

    test('a short balance is refused', async () => {
        const db = makeDb({ balance: 5 });
        await expect(payStay(db)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        expect(user(db, 10).availableBalance).toBe(5);
    });

    test('a room taken, closed or too small, or your own hotel, is refused', async () => {
        const taken = makeDb();
        taken.reservation.rows.push({ id: 'x', businessProfileId: 'bp-h', serviceItemId: 'r1', status: 'CONFIRMED', startDatetime: IN, endDatetime: OUT });
        await expect(payStay(taken)).rejects.toMatchObject({ code: 'BOOKED', httpStatus: 409 });

        const closed = makeDb();
        closed.hotelRoomBlock.rows.push({ id: 'b', roomId: 'r1', startDate: IN, endDate: OUT });
        await expect(payStay(closed)).rejects.toMatchObject({ code: 'BLOCKED' });

        await expect(payStay(makeDb(), { roomId: 'r2', partySize: 2 })).rejects.toMatchObject({ code: 'TOO_SMALL' });

        const own = makeDb();
        own.businessProfile.rows[0].userId = 10;
        await expect(payStay(own)).rejects.toMatchObject({ code: 'SELF_PAYMENT' });
        for (const db of [taken, closed, own]) expect(user(db, 10).availableBalance).toBe(500);
    });

    test('the escrow outlives the stay', async () => {
        const db = makeDb();
        await payStay(db);
        expect(new Date(escrow(db).expiresAt).getTime()).toBeGreaterThanOrEqual(OUT.getTime() + 7 * DAY);
    });

    test('the quote charges exactly what the payment charges', async () => {
        const db = makeDb();
        const ctrl = require('../controllers/hotelMarketplaceController');
        let body = null;
        await ctrl.getStayQuote({
            app: { get: () => db }, params: { bizId: 'BIZ-H' }, query: { checkIn: iso(IN), checkOut: iso(OUT), guests: '2' },
        }, { status() { return this; }, json(b) { body = b; return this; } });
        const r1 = body.rooms.find((r) => r.roomId === 'r1');
        expect(body.payAt).toBe('APP');
        const out = await payStay(db, { expectedTotalUsdc: r1.payTotalUsdc.toFixed(6) });
        expect(out.payment.totalUsdc).toBe(r1.payTotalUsdc);
        expect(out.payment.feeUsdc).toBe(r1.feeUsdc);
    });
});

describe('after paying', () => {
    test("the guest's QR check-in releases the price to the hotel", async () => {
        const db = makeDb();
        const out = await payStay(db);
        // The QR path (qrCheckInService.verifyAndCheckIn) calls this authority.
        await lifecycle.checkInReservation(db, { reservationId: out.reservation.id, businessUserId: 20, requireFreshClaim: true });
        expect(reservation(db).status).toBe('CHECKED_IN');
        expect(escrow(db).status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBeCloseTo(out.payment.amountUsdc, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
    });

    test('staff cannot check a paid stay in by hand', async () => {
        const db = makeDb();
        const out = await payStay(db);
        const call = async (fn, req) => {
            let status = null; let payload = null;
            await fn({ app: { get: (k) => (k === 'prisma' ? db : null) }, user: { id: 20 }, ...req },
                { status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
            return { status, payload };
        };
        const r1 = await call(require('../controllers/reservationController').checkInReservation, { params: { reservationId: out.reservation.id } });
        expect(r1.status).toBe(409);
        expect(r1.payload.code).toBe('QR_CHECKIN_REQUIRED');
        const r2 = await call(require('../controllers/marketplaceController').businessCheckIn, { body: { reservationId: out.reservation.id } });
        expect(r2.status).toBe(409);
        expect(r2.payload.code).toBe('QR_CHECKIN_REQUIRED');
        expect(reservation(db).status).toBe('CONFIRMED');
        expect(escrow(db).status).toBe('FUNDED');
    });

    test('the hotel cancelling refunds the price, and the guest is told', async () => {
        const db = makeDb();
        const out = await payStay(db);
        const sendNotification = jest.fn().mockResolvedValue(undefined);
        let status = null; let payload = null;
        await require('../controllers/reservationController').declineReservation({
            app: { get: (k) => ({ prisma: db, notificationService: { sendNotification } }[k]) },
            user: { id: 20 }, params: { reservationId: out.reservation.id }, body: { reason: 'Pipe burst' },
        }, { status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
        expect(status).toBe(200);
        expect(payload.reservation.status).toBe('CANCELLED_BUSINESS');
        expect(escrow(db).status).toBe('REFUNDED');
        expect(user(db, 10).availableBalance).toBeCloseTo(500 - out.payment.feeUsdc, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 10, title: 'Your stay was cancelled' }));
    });

    test('the guest cancelling refunds the price', async () => {
        const db = makeDb();
        const out = await payStay(db);
        await lifecycle.cancelReservation(db, { reservationId: out.reservation.id, customerId: 10 });
        expect(reservation(db).status).toBe('CANCELLED_CUSTOMER');
        expect(escrow(db).status).toBe('REFUNDED');
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
    });

    test('a stay that ends with no check-in is refunded', async () => {
        const db = makeDb();
        const out = await payStay(db);
        reservation(db).endDatetime = new Date(Date.now() - 1000); // the stay has ended
        await lifecycle.markNoShowReservation(db, { reservationId: out.reservation.id, worker: true });
        expect(reservation(db).status).toBe('NO_SHOW');
        expect(escrow(db).status).toBe('REFUNDED');
        expect(user(db, 20).availableBalance).toBe(0);
    });

    test("a paid stay's no-show terms cannot change", async () => {
        const db = makeDb();
        const out = await payStay(db);
        let status = null; let payload = null;
        await require('../controllers/marketplaceController').setPenaltyPolicy({
            app: { get: () => db }, user: { id: 20 }, body: { reservationId: out.reservation.id, noShowPenaltyPct: 0.5 },
        }, { status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
        expect(status).toBe(409);
        expect(payload.code).toBe('PENALTY_LOCKED');
        expect(reservation(db).noShowPenaltyPct).toBeUndefined();
    });
});

describe('routes', () => {
    test('a paid stay passes the wallet-pay gates and the second factor', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/marketplaceRoutes.js'), 'utf-8');
        const start = src.indexOf("router.post('/business/:bizId/reservations'");
        const route = src.slice(start, src.indexOf('hotelCtrl.createHotelReservation', start));
        expect(route).toContain('...walletPayGates');
        expect(route.indexOf('...walletPayGates')).toBeLessThan(route.indexOf('whenPayingWithWallet(require2FA())'));
        expect(route).toContain('whenPayingWithWallet(idempotency(');
        const res = require('fs').readFileSync(require('path').join(__dirname, '../routes/reservationRoutes.js'), 'utf-8');
        expect(res).toContain("router.patch('/:reservationId/decline', protect,");
    });
});
