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
//   • the hotel declining or cancelling refunds everything, the fee included
//     (if the profit bucket was emptied, the fee is recorded as owed and the
//     refund still goes through); the guest cancelling or a stay that ends
//     with no check-in refunds the price and keeps the fee
//   • a paid stay's no-show terms cannot change afterwards
//   • the escrow outlives the stay; the quote charges what the payment does
//   • a retry finds its stay before anything is re-priced
//   • the business's booking lock is taken before the room row
//   • its dates cannot be moved (Business OS, counter-proposals)
//   • the generic escrow endpoints cannot complete or dispute it
//   • the QR works from 24 hours before the check-in day to noon on the
//     check-out day; a late arrival is not a no-show before that
//   • a failed payment says only what is proven
// Real PostgreSQL (rollback, the room lock, the wired idempotency claim) is
// stay-wallet-pay.pg.test.js.
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
const HOUR = 60 * 60 * 1000;
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
        Object.defineProperty(r, 'customer', { get: () => db.user.rows.find((u) => u.id === r.customerId) || null, enumerable: false });
        return r;
    };
    const create = db.reservation.create;
    db.reservation.create = jest.fn(async (args) => decorate(await create(args)));
    db.decorate = decorate;
    const createEscrow = db.smartEscrow.create;
    db.smartEscrow.create = jest.fn(async (args) => {
        const e = await createEscrow(args);
        Object.defineProperty(e, 'reservation', { get: () => db.reservation.rows.find((r) => r.escrowId === e.id) || null, enumerable: false });
        Object.defineProperty(e, 'transitBooking', { get: () => null, enumerable: false });
        return e;
    });
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

    test('the hotel cancelling refunds everything, the fee included, and the guest is told', async () => {
        const db = makeDb();
        require('../services/ledgerService').post.mockClear();
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
        expect(user(db, 10).availableBalance).toBeCloseTo(500, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
        // The fee's revenue is reversed everywhere it was booked.
        expect(db.systemProfitFees.rows[0].balance).toBeCloseTo(0, 9);
        // Lock order as at funding: the payer's row before the profit bucket.
        const lastOrder = (fn) => fn.mock.invocationCallOrder[fn.mock.invocationCallOrder.length - 1];
        expect(lastOrder(db.user.updateMany)).toBeLessThan(lastOrder(db.systemProfitFees.updateMany));
        expect(db.adminProfitLog.rows.map((r) => r.amountUsdc)).toEqual([out.payment.feeUsdc, -out.payment.feeUsdc]);
        const ledger = require('../services/ledgerService');
        const refundPost = ledger.post.mock.calls.map((c) => c[1]).find((e) => e.entryType === 'ESCROW_REFUND');
        expect(refundPost.lines).toEqual([
            { account: `escrow:escrow-${escrow(db).id}:locked`, debit: out.payment.amountUsdc.toFixed(8) },
            { account: 'revenue:fees', debit: out.payment.feeUsdc.toFixed(8) },
            { account: 'user:10:liability', credit: out.payment.totalUsdc.toFixed(8) },
        ]);
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 10, title: 'Your stay was cancelled' }));
        const { body } = sendNotification.mock.calls[0][0];
        expect(body).toContain(`Everything you paid (${out.payment.totalUsdc.toFixed(2)} USDC, the Azaman fee included) is back in your wallet.`);
    });

    test('an emptied profit bucket never blocks the refund: the fee is recorded as owed', async () => {
        const db = makeDb();
        const out = await payStay(db);
        db.systemProfitFees.rows[0].balance = 0; // the fees were withdrawn
        db.$executeRawUnsafe = jest.fn(async () => 0); // savepoints
        db.$queryRawUnsafe = jest.fn(async () => [{ id: 'rx-1' }]);
        const sendNotification = jest.fn().mockResolvedValue(undefined);
        let status = null;
        await require('../controllers/reservationController').declineReservation({
            app: { get: (k) => ({ prisma: db, notificationService: { sendNotification } }[k]) },
            user: { id: 20 }, params: { reservationId: out.reservation.id }, body: {},
        }, { status(c) { status = c; return this; }, json() { return this; } });
        expect(status).toBe(200);
        expect(escrow(db).status).toBe('REFUNDED');
        expect(user(db, 10).availableBalance).toBeCloseTo(500 - out.payment.feeUsdc, 9);
        expect(db.systemProfitFees.rows[0].balance).toBe(0);
        const history = db.transactionHistory.rows.find((h) => h.type === 'TICKET_ESCROW_REFUND');
        expect(history.metadata).toEqual({ priceUsdc: out.payment.amountUsdc, feeRefundedUsdc: 0, feeRefundOwedUsdc: out.payment.feeUsdc });
        // ...and it is on the team's reconciliation queue until paid.
        const insert = db.$queryRawUnsafe.mock.calls.find((c) => String(c[0]).includes('INSERT INTO "ReconciliationException"'));
        expect(insert.slice(1, 5)).toEqual(['BOOKING_FEE_REFUND', escrow(db).id, escrow(db).refundTxHash, 'FEE_REFUND_OWED']);
        expect(JSON.parse(insert[5])).toEqual(expect.objectContaining({ payerId: 10, feeUsdc: out.payment.feeUsdc.toFixed(8) }));
        expect(sendNotification.mock.calls[0][0].body).toContain(
            `Our team will refund the Azaman fee (${out.payment.feeUsdc.toFixed(2)} USDC) to you separately.`,
        );
    });

    test('the guest cancelling refunds the price', async () => {
        const db = makeDb();
        const out = await payStay(db);
        await lifecycle.cancelReservation(db, { reservationId: out.reservation.id, customerId: 10 });
        expect(reservation(db).status).toBe('CANCELLED_CUSTOMER');
        expect(escrow(db).status).toBe('REFUNDED');
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
        // The guest cancelled: the price comes back, the fee is kept.
        expect(user(db, 10).availableBalance).toBeCloseTo(500 - out.payment.feeUsdc, 9);
        expect(db.systemProfitFees.rows[0].balance).toBeCloseTo(out.payment.feeUsdc, 9);
    });

    test('a stay that ends with no check-in is refunded', async () => {
        const db = makeDb();
        const out = await payStay(db);
        // Past noon on the check-out day (a paid stay waits 12 hours for a
        // late arrival: paidStayPolicy).
        reservation(db).endDatetime = new Date(Date.now() - 13 * HOUR);
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

// The request body a client resends on a retry: the first quote's total.
const retry = (db, first, extra = {}) => stay.bookPaidStay(db, {
    bizId: 'BIZ-H', roomId: 'r1', customerId: 10, checkInDate: iso(IN), checkOutDate: iso(OUT), partySize: 2,
    expectedTotalUsdc: first.payment.totalUsdc.toFixed(6), clientRequestKey: 'key-1', ...extra,
});

describe('retries', () => {
    test('a retry after the hotel changed its price still returns the stay it paid for', async () => {
        const db = makeDb();
        const first = await payStay(db);
        const balance = user(db, 10).availableBalance;
        db.hotelRoom.rows[0].basePriceUsdc = 80;
        const again = await retry(db, first);
        expect(again.replayed).toBe(true);
        expect(again.reservation.id).toBe(first.reservation.id);
        expect(db.smartEscrow.rows).toHaveLength(1);
        expect(user(db, 10).availableBalance).toBe(balance);
        // A new request at the old total is refused: nothing charged.
        await expect(retry(db, first, { clientRequestKey: 'key-2' })).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
        expect(user(db, 10).availableBalance).toBe(balance);
    });

    test('a retry after midnight (check-in now in the past) still returns the stay', async () => {
        const db = makeDb();
        const inDay = iso(utcDay(0));
        const outDay = iso(utcDay(1));
        const p = await stay.priceStay(db, { bizId: 'BIZ-H', roomId: 'r1', checkInDate: inDay, checkOutDate: outDay, partySize: 2 });
        const args = {
            bizId: 'BIZ-H', roomId: 'r1', customerId: 10, checkInDate: inDay, checkOutDate: outDay, partySize: 2,
            expectedTotalUsdc: p.totalUsdc.toFixed(6), clientRequestKey: 'key-1',
        };
        const first = await stay.bookPaidStay(db, args);
        const tomorrow = Date.now() + 2 * DAY;
        const again = await stay.bookPaidStay(db, { ...args, now: tomorrow });
        expect(again.replayed).toBe(true);
        expect(again.reservation.id).toBe(first.reservation.id);
        await expect(stay.bookPaidStay(db, { ...args, clientRequestKey: 'key-2', now: tomorrow }))
            .rejects.toMatchObject({ code: 'DATES_PAST' });
        expect(db.smartEscrow.rows).toHaveLength(1);
    });
});

describe('locks', () => {
    test("the business's booking lock is taken before the room row", async () => {
        const db = makeDb();
        await payStay(db);
        const sql = db.$executeRaw.mock.calls.map((c) => c[0].join('?'));
        const bizLock = sql.findIndex((q) => q.includes('pg_advisory_xact_lock(hashtextextended('));
        const roomLock = sql.findIndex((q) => q.includes('FROM "HotelRoom"') && q.includes('FOR UPDATE'));
        expect(bizLock).toBeGreaterThanOrEqual(0);
        expect(roomLock).toBeGreaterThan(bizLock);
        // The capacity trigger's key: the business, namespace 91731.
        expect(db.$executeRaw.mock.calls[bizLock].slice(1)).toEqual(['bp-h', 91731]);
    });
});

describe("a paid stay's dates are fixed", () => {
    const osHandler = (path) => {
        const router = require('../routes/businessOSRoutes');
        const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
        return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const callOs = (db, path, req) => new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        osHandler(path)({ app: { get: (k) => (k === 'prisma' ? db : null) }, user: { id: 20 }, params: {}, body: {}, ...req }, res,
            (err) => (err ? reject(err) : resolve({ status: null })));
    });

    test('Business OS cannot propose or apply new dates', async () => {
        const db = makeDb();
        const out = await payStay(db);
        const id = out.reservation.id;
        const propose = await callOs(db, '/reservations/:id/propose-reschedule', { params: { id }, body: { proposedStartDatetime: iso(utcDay(20)) } });
        expect(propose.status).toBe(409);
        expect(propose.body.code).toBe('PAID_DATES_FIXED');
        expect(reservation(db).proposedStartDatetime).toBeUndefined();

        // A proposal from before the stay was paid cannot be applied either.
        reservation(db).proposedStartDatetime = utcDay(20);
        reservation(db).proposedEndDatetime = utcDay(22);
        const accept = await callOs(db, '/reservations/:id/respond-reschedule', { params: { id }, body: { accept: true } });
        expect(accept.status).toBe(409);
        expect(accept.body.code).toBe('PAID_DATES_FIXED');
        expect(reservation(db).startDatetime).toEqual(IN);
        expect(reservation(db).endDatetime).toEqual(OUT);
        expect(escrow(db).status).toBe('FUNDED');
        // Checked under the reservation's row lock.
        expect(db.$executeRaw.mock.calls.some((c) => c[0].join('?').includes('FROM "Reservation"'))).toBe(true);
    });

    test('the guest cannot accept a counter-proposal on it', async () => {
        const db = makeDb();
        const out = await payStay(db);
        reservation(db).proposedStartDatetime = utcDay(20);
        reservation(db).proposedEndDatetime = utcDay(22);
        let status = null; let payload = null;
        await require('../controllers/reservationController').acceptCounterProposal({
            prisma: db, user: { id: 10 }, params: { reservationId: out.reservation.id },
        }, { status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
        expect(status).toBe(409);
        expect(payload.code).toBe('PAID_DATES_FIXED');
        expect(reservation(db).startDatetime).toEqual(IN);
    });

    test('an unpaid request can still be rescheduled', async () => {
        const db = makeDb();
        db.reservation.rows.push(db.decorate({
            id: 'u1', businessProfileId: 'bp-h', customerId: 10, serviceItemId: 'r1', status: 'PENDING',
            escrowId: null, startDatetime: IN, endDatetime: OUT,
        }));
        const propose = await callOs(db, '/reservations/:id/propose-reschedule', { params: { id: 'u1' }, body: { proposedStartDatetime: iso(utcDay(20)) } });
        expect(propose.status).toBe(200);
        expect(db.reservation.rows[0].proposedStartDatetime).toEqual(new Date(iso(utcDay(20))));
    });

    test('a refunded booking is not held, so its dates can move', async () => {
        const db = makeDb();
        const out = await payStay(db);
        escrow(db).status = 'REFUNDED';
        await expect(stay.assertDatesMovableTx(db, out.reservation.id)).resolves.toBeUndefined();
        escrow(db).status = 'DISPUTED';
        await expect(stay.assertDatesMovableTx(db, out.reservation.id)).rejects.toMatchObject({ code: 'PAID_DATES_FIXED', httpStatus: 409 });
    });
});

describe('the generic escrow endpoints leave a paid stay alone', () => {
    test('neither the hotel nor the guest can complete or dispute it there', async () => {
        const db = makeDb();
        const out = await payStay(db);
        const ctrl = require('../controllers/escrowController');
        const cases = [
            [ctrl.markSatisfied, 20, {}],
            [ctrl.markSatisfied, 10, {}],
            [ctrl.raiseDispute, 20, { reason: 'The guest will not come' }],
            [ctrl.raiseDispute, 10, { reason: 'Changed my mind' }],
        ];
        for (const [fn, userId, extra] of cases) {
            let status = null; let payload = null;
            const locals = {};
            await fn({
                app: { get: (k) => (k === 'prisma' ? db : null) }, user: { id: userId, username: 'u' },
                body: { escrowId: out.payment.escrowId, ...extra }, ip: '127.0.0.1',
            }, { locals, status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
            expect(status).toBe(409);
            expect(payload.code).toBe('BOOKING_ESCROW');
            expect(locals.financialClaimRelease).toBe(true);
        }
        expect(escrow(db).status).toBe('FUNDED');
        expect(escrow(db).payerSatisfied).toBeFalsy();
        expect(escrow(db).payeeSatisfied).toBeFalsy();
        expect(user(db, 20).availableBalance).toBe(0);
    });
});

describe('checking in with the QR', () => {
    const KEY = 'qr_checkin_test_key_0123456789abcdefghij';
    beforeAll(() => { process.env.QR_CHECKIN_SIGNING_KEY = KEY; });
    afterAll(() => { delete process.env.QR_CHECKIN_SIGNING_KEY; });
    const scan = async (db, reservationId) => {
        const qr = require('../services/qrCheckInService');
        const { token } = await qr.generateCheckInToken(db, { reservationId, customerId: 10 });
        return qr.verifyAndCheckIn(db, { token, businessUserId: 20 });
    };
    const at = (db, startOffsetMs, endOffsetMs) => {
        reservation(db).startDatetime = new Date(Date.now() + startOffsetMs);
        reservation(db).endDatetime = new Date(Date.now() + endOffsetMs);
    };

    test('on the day, the scan pays the hotel', async () => {
        const db = makeDb();
        const out = await payStay(db);
        at(db, -2 * HOUR, 22 * HOUR);
        await scan(db, out.reservation.id);
        expect(reservation(db).status).toBe('CHECKED_IN');
        expect(escrow(db).status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBeCloseTo(out.payment.amountUsdc, 9);
    });

    test('the evening before is early enough; a week before pays nothing out', async () => {
        const db = makeDb();
        const out = await payStay(db); // check-in a week out
        await expect(scan(db, out.reservation.id)).rejects.toMatchObject({ code: 'QR_CHECKIN_NOT_OPEN' });
        expect(reservation(db).status).toBe('CONFIRMED');
        expect(escrow(db).status).toBe('FUNDED');
        expect(user(db, 20).availableBalance).toBe(0);
        at(db, 4 * HOUR, 28 * HOUR); // arrives 4 hours before the check-in day
        await scan(db, out.reservation.id);
        expect(escrow(db).status).toBe('SETTLED');
    });

    test('a late arrival checks in until noon on the check-out day, and is not a no-show before', async () => {
        const db = makeDb();
        const out = await payStay(db);
        at(db, -26 * HOUR, -2 * HOUR); // the night is over: they land at 2am
        await expect(lifecycle.markNoShowReservation(db, { reservationId: out.reservation.id, worker: true }))
            .rejects.toMatchObject({ code: 'RESERVATION_NOT_NO_SHOW_READY' });
        const swept = await require('../workers/reservationNoShowWorker').sweepNoShowReservations(db);
        expect(swept.processed).toBe(0);
        expect(escrow(db).status).toBe('FUNDED');
        await scan(db, out.reservation.id);
        expect(reservation(db).status).toBe('CHECKED_IN');
        expect(escrow(db).status).toBe('SETTLED');
    });

    test('after noon on the check-out day it is closed, and the sweep refunds it', async () => {
        const db = makeDb();
        const out = await payStay(db);
        at(db, -37 * HOUR, -13 * HOUR);
        await expect(scan(db, out.reservation.id)).rejects.toThrow(/check-in is closed/);
        const swept = await require('../workers/reservationNoShowWorker').sweepNoShowReservations(db);
        expect(swept.processed).toBe(1);
        expect(reservation(db).status).toBe('NO_SHOW');
        expect(escrow(db).status).toBe('REFUNDED');
        expect(user(db, 20).availableBalance).toBe(0);
    });

    test('a reservation not paid in the app keeps its own window', async () => {
        const db = makeDb();
        db.reservation.rows.push(db.decorate({
            id: 'u1', reservationRef: 'RES-U1', businessProfileId: 'bp-h', customerId: 10, status: 'CONFIRMED',
            escrowId: null, startDatetime: new Date(Date.now() - 26 * HOUR), endDatetime: new Date(Date.now() - 2 * HOUR),
        }));
        await expect(scan(db, 'u1')).rejects.toThrow(/check-in is closed/);
    });
});

describe("the guest's list and the hotel's integrations", () => {
    test('the list says where the money is', async () => {
        const db = makeDb();
        await payStay(db);
        let payload = null;
        await require('../controllers/reservationController').listMyReservations({
            app: { get: () => db }, user: { id: 10 }, query: {},
        }, { status() { return this; }, json(p) { payload = p; return this; } });
        expect(db.reservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
            include: expect.objectContaining({ escrow: { select: { status: true, amountUsdc: true, feeUsdc: true } } }),
        }));
        expect(payload.reservations).toHaveLength(1);
    });

    test('the new paid stay is a reservation.created event, once', async () => {
        const { emitWebhookEvent } = require('../services/webhookEmitter');
        emitWebhookEvent.mockClear();
        const db = makeDb();
        const out = await payStay(db);
        await payStay(db); // a retry: replayed, no second event
        const created = emitWebhookEvent.mock.calls.filter((c) => c[1] === 'reservation.created');
        expect(created).toHaveLength(1);
        expect(created[0][0]).toBe('bp-h');
        expect(created[0][2]).toEqual(expect.objectContaining({
            reservationId: out.reservation.id, paid: true, escrowId: out.payment.escrowId,
        }));
    });
});

describe('a failed payment says only what is proven', () => {
    const attempt = async (failure) => {
        const db = makeDb();
        const spy = jest.spyOn(stay, 'bookPaidStay').mockRejectedValue(failure);
        let status = null; let payload = null;
        try {
            await require('../controllers/hotelMarketplaceController').createHotelReservation({
                app: { get: (k) => (k === 'prisma' ? db : null) }, params: { bizId: 'BIZ-H' }, user: { id: 10 },
                body: { payWith: 'WALLET', roomId: 'r1', checkInDate: iso(IN), checkOutDate: iso(OUT), expectedTotalUsdc: '101.000000' },
                get: () => 'key-1',
            }, { locals: {}, status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
        } finally {
            spy.mockRestore();
        }
        return { status, payload };
    };

    test('the capacity trigger or a unique index refusing: booked, nothing charged', async () => {
        for (const failure of [
            Object.assign(new Error('Raw query failed. reservation_capacity_exceeded for "bp-h"'), { code: 'P2004' }),
            Object.assign(new Error('Unique constraint failed on the fields: (`reservationRef`)'), { code: 'P2002' }),
        ]) {
            const { status, payload } = await attempt(failure);
            expect(status).toBe(409);
            expect(payload.code).toBe('BOOKED');
            expect(payload.message).toBe('This room was just booked for those dates. Nothing was charged.');
        }
    });

    test('anything unexpected: a 500 that neither leaks the database nor claims nothing was charged', async () => {
        const { status, payload } = await attempt(new Error('Connection terminated unexpectedly while running SELECT "HotelRoom"'));
        expect(status).toBe(500);
        expect(payload.code).toBe('PAYMENT_UNCONFIRMED');
        expect(payload.message).not.toMatch(/Connection|SELECT|HotelRoom/);
        expect(payload.message).not.toMatch(/Nothing was charged/);
    });

    test('a short balance is 402; our own refusals pass through', async () => {
        const short = await attempt(Object.assign(new Error('Insufficient balance.'), { code: 'INSUFFICIENT_BALANCE' }));
        expect(short.status).toBe(402);
        expect(short.payload.code).toBe('INSUFFICIENT_BALANCE');
        const changed = await attempt(Object.assign(new Error('The price changed.'), { code: 'PRICE_CHANGED', httpStatus: 409 }));
        expect(changed.status).toBe(409);
        expect(changed.payload).toEqual({ success: false, code: 'PRICE_CHANGED', message: 'The price changed.' });
    });
});

