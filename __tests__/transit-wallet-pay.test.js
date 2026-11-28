// =============================================================================
// Transit wallet pay — book AND pay in one transaction; release on completion.
//
// Runs against a small in-memory Prisma fake (no database), so the economic
// behaviour is checked on every run:
//   • payWith WALLET creates the booking escrow, debits fare + fee from the
//     passenger, locks the fare, confirms the booking and returns the payment
//   • the quote charges exactly what the booking charges
//   • a short balance throws before anything commits (the wired idempotency
//     claim is never committed)
//   • nobody pays for seats on their own trip
//   • completing the trip releases the fare to the operator, once
//   • the expiry worker's cancel is pinned to PENDING, so a booking paid in
//     between is never cancelled and refunded from under the passenger
// The real-PostgreSQL atomicity (rollback on failure) is covered by the
// transit-wallet-pay.pg.test.js suite in CI.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messagingChannels', () => ({ notifyBookingConfirmed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ replayed: false }) }));

const ledger = require('../services/ledgerService');
const {
    bookSeats, quoteSeats, completeTransitBooking, cancelTransitBooking,
} = require('../services/transitBookingService');

// ── a tiny in-memory Prisma ──────────────────────────────────────────────────
const num = (v) => Number(v);
function matches(row, where = {}) {
    return Object.entries(where).every(([k, cond]) => {
        const v = row[k];
        if (cond === null) return v === null || v === undefined;
        if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
            if ('in' in cond) return cond.in.includes(v);
            if ('gte' in cond) return num(v) >= num(cond.gte);
            return Object.entries(cond).every(([ck, cv]) => matches(v || {}, { [ck]: cv }));
        }
        return v === cond;
    });
}
function applyData(row, data) {
    for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
            row[k] = num(row[k] || 0) + ('increment' in v ? num(v.increment) : -num(v.decrement));
        } else {
            row[k] = v;
        }
    }
    return row;
}
function table(rows) {
    let seq = 0;
    return {
        rows,
        findUnique: jest.fn(async ({ where }) => rows.find(r => matches(r, where)) || null),
        findFirst: jest.fn(async ({ where }) => rows.find(r => matches(r, where)) || null),
        findMany: jest.fn(async ({ where }) => rows.filter(r => matches(r, where))),
        create: jest.fn(async ({ data }) => { const r = { id: data.id || `id-${rows.length + 1}-${++seq}`, ...data }; rows.push(r); return r; }),
        createMany: jest.fn(async ({ data }) => { data.forEach(d => rows.push({ ...d })); return { count: data.length }; }),
        update: jest.fn(async ({ where, data }) => applyData(rows.find(r => matches(r, where)), data)),
        updateMany: jest.fn(async ({ where, data }) => {
            const hit = rows.filter(r => matches(r, where));
            hit.forEach(r => applyData(r, data));
            return { count: hit.length };
        }),
        upsert: jest.fn(async ({ where, create }) => rows.find(r => matches(r, where)) || (rows.push({ ...create }), create)),
        deleteMany: jest.fn(async ({ where }) => {
            const keep = rows.filter(r => !matches(r, where));
            const n = rows.length - keep.length;
            rows.splice(0, rows.length, ...keep);
            return { count: n };
        }),
    };
}

const LAYOUT = [
    { seatId: '1A', row: 1, col: 1, type: 'WINDOW' },
    { seatId: '1B', row: 1, col: 2, type: 'AISLE' },
    { seatId: '2A', row: 2, col: 1, type: 'WINDOW', tier: 'VIP' },
];

function makeDb({ passengerBalance = 100, operatorId = 20, fee = null } = {}) {
    const db = {
        transitTrip: table([{
            id: 'trip-1', businessProfileId: 'bp-1', vehicleId: 'v-1', status: 'SCHEDULED',
            origin: 'Circle', destination: 'Madina', departureAt: new Date('2026-12-01T07:30:00Z'),
            fareUsdc: 2, availableSeats: 3, metadata: { tierFares: { VIP: 5 } },
            vehicle: { seatMap: { layout: LAYOUT } },
            businessProfile: { id: 'bp-1', userId: operatorId, isSuspended: false },
        }]),
        transitBookingSeat: table([]),
        transitBooking: table([]),
        globalSettings: table([{ id: 1, smartEscrowFeePct: fee, escrowFundedExpiryDays: 30 }]),
        user: table([
            { id: 10, availableBalance: passengerBalance, escrowLockedBalance: 0 },
            { id: operatorId, availableBalance: 0, escrowLockedBalance: 0 },
        ]),
        ticket: table([]),
        smartEscrow: table([]),
        systemProfitFees: table([{ id: 1, balance: 0 }]),
        transactionHistory: table([]),
        adminProfitLog: table([]),
        financialOperation: table([{ id: 'op-1', status: 'IN_PROGRESS' }]),
        $executeRaw: jest.fn(async () => 1),
    };
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
}

const user = (db, id) => db.user.rows.find(u => u.id === id);

describe('bookSeats with payWith WALLET', () => {
    beforeEach(() => ledger.post.mockClear());

    test('books, pays from the wallet and confirms, in one transaction', async () => {
        const db = makeDb();
        const res = await bookSeats(db, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'],
            payWith: 'WALLET', financialOperation: { id: 'op-1' },
        });

        // One transaction carried the booking AND the money.
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        // Fare is tier-aware: 2 (standard) + 5 (VIP) = 7; fee 0.5% = 0.035.
        expect(res.totalFare).toBe(7);
        expect(res.payment).toEqual(expect.objectContaining({
            method: 'WALLET', amountUsdc: 7, feeUsdc: 0.035, totalUsdc: 7.035,
        }));
        expect(res.booking.status).toBe('CONFIRMED');
        expect(res.booking.escrowId).toBe(res.payment.escrowId);

        // Passenger debited fare + fee; the fare is locked, not yet the operator's.
        expect(user(db, 10).availableBalance).toBeCloseTo(100 - 7.035, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(7, 9);
        expect(user(db, 20).availableBalance).toBe(0);
        const escrow = db.smartEscrow.rows[0];
        expect(escrow).toEqual(expect.objectContaining({ status: 'FUNDED', payerId: 10, payeeId: 20, amountUsdc: 7 }));

        // The ledger posting is the escrow lock (principal + fee).
        expect(ledger.post).toHaveBeenCalledWith(db, expect.objectContaining({ entryType: 'ESCROW_LOCK' }));

        // The wired claim committed with the exact response, payment included.
        const op = db.financialOperation.rows[0];
        expect(op.status).toBe('COMMITTED');
        expect(JSON.parse(op.responseBody).payment.totalUsdc).toBe(7.035);
        // Seats taken and capacity decremented.
        expect(db.transitBookingSeat.rows.map(s => s.seatId)).toEqual(['1A', '2A']);
        expect(db.transitTrip.rows[0].availableSeats).toBe(1);
    });

    test('the quote charges exactly what the booking charges', async () => {
        const db = makeDb({ fee: 0.01 });
        const quote = await quoteSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'] });
        expect(quote).toEqual(expect.objectContaining({
            currency: 'USDC', fareUsdc: 7, feeUsdc: 0.07, totalUsdc: 7.07, availableUsdc: 100, canPay: true,
        }));
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A', '2A'], payWith: 'WALLET' });
        expect(res.payment.totalUsdc).toBe(quote.totalUsdc);
    });

    test('a short balance throws before the claim commits', async () => {
        const db = makeDb({ passengerBalance: 1 });
        await expect(bookSeats(db, {
            tripId: 'trip-1', customerId: 10, seatIds: ['1A'],
            payWith: 'WALLET', financialOperation: { id: 'op-1' },
        })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        // The real transaction rolls everything back; here we check the
        // response was never committed and nothing was debited.
        expect(db.financialOperation.rows[0].status).toBe('IN_PROGRESS');
        expect(user(db, 10).availableBalance).toBe(1);
        expect(ledger.post).not.toHaveBeenCalled();
    });

    test('the quote says when the wallet cannot cover it', async () => {
        const db = makeDb({ passengerBalance: 1 });
        const quote = await quoteSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'] });
        expect(quote.canPay).toBe(false);
    });

    test('nobody pays for seats on their own trip', async () => {
        const db = makeDb({ operatorId: 10 });
        await expect(bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET' }))
            .rejects.toMatchObject({ code: 'SELF_PAYMENT', httpStatus: 409 });
        expect(db.$transaction).not.toHaveBeenCalled();
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
    async function paidAndBoarded() {
        const db = makeDb();
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET' });
        db.transitBooking.rows[0].status = 'IN_PROGRESS'; // boarded (QR check-in)
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
        // Escrow row locked first (shared lifecycle lock order).
        expect(db.$executeRaw).toHaveBeenCalled();
    });

    test('completing twice converges without paying twice', async () => {
        const { db, bookingId } = await paidAndBoarded();
        await completeTransitBooking(db, { bookingId });
        const again = await completeTransitBooking(db, { bookingId });
        expect(again.alreadyCompleted).toBe(true);
        expect(again.release).toBeNull();
        expect(user(db, 20).availableBalance).toBe(2);
    });

    test('a booking that has not boarded cannot be completed', async () => {
        const db = makeDb();
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET' });
        await expect(completeTransitBooking(db, { bookingId: res.booking.id }))
            .rejects.toMatchObject({ code: 'NOT_COMPLETABLE', httpStatus: 409 });
        expect(user(db, 20).availableBalance).toBe(0);
    });
});

describe('expiry cancel is pinned to PENDING', () => {
    test('a booking paid before the expiry claim is not cancelled or refunded', async () => {
        const db = makeDb();
        const res = await bookSeats(db, { tripId: 'trip-1', customerId: 10, seatIds: ['1A'], payWith: 'WALLET' });
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
        const out = await call(makeDb({ operatorId: 10 }), { seatIds: ['1A'], payWith: 'WALLET' });
        expect(out.status).toBe(409);
        expect(out.payload).toEqual(expect.objectContaining({ success: false, code: 'SELF_PAYMENT' }));
    });

    test('a short balance is 402 INSUFFICIENT_BALANCE', async () => {
        const out = await call(makeDb({ passengerBalance: 1 }), { seatIds: ['1A'], payWith: 'WALLET' });
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

    test('wallet-pay gates run before the second factor on the booking route', () => {
        const line = src.split('\n').find(l => l.includes("'/transit/trips/:id/book'") && l.includes('router'));
        expect(line).toBeTruthy();
        expect(line.indexOf('...walletPayGates')).toBeGreaterThan(-1);
        expect(line.indexOf('...walletPayGates')).toBeLessThan(line.indexOf('require2FA()'));
        expect(src).toContain("whenPayingWithWallet(requireKyc('pay'))");
        expect(src).toContain('whenPayingWithWallet(checkBan)');
    });

    test('the quote route is read-only (GET)', () => {
        expect(src).toContain("router.get('/transit/trips/:id/quote', protect, ctrl.quoteTripSeats)");
    });
});
