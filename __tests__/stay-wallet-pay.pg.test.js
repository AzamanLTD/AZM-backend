'use strict';

// =============================================================================
// A HOTEL STAY PAID FROM THE WALLET (real PostgreSQL).
//   H1. Paying books, pays and confirms in one commit; the guest's QR
//       check-in releases the price to the hotel, once.
//   H2. A short balance rolls everything back: no reservation, ticket or
//       escrow; the balance untouched.
//   H3. Two guests paying for the same room and dates at the same moment:
//       the room lock lets exactly one through; the other is refused and
//       charged nothing.
//   H4. The hotel cancelling refunds everything, the fee included: the
//       profit bucket gives it back and the ledger balances. With the bucket
//       emptied, the price is still refunded and the fee recorded as owed.
//   H5. Through the route's real idempotency middleware and the controller:
//       the claim commits with the stay; a same-key retry replays it and
//       charges nothing; a different stay under the key is refused; a short
//       balance releases the key, so the same key pays once topped up.
// =============================================================================

const { seedUser, seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('hotel stay paid from the wallet (PostgreSQL)', () => {
    let prisma;
    let stay;
    let lifecycle;

    const truncate = () => prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "User", "BusinessProfile", "HotelRoom", "Reservation", "Ticket", "SmartEscrow", '
        + '"SystemProfitFees", "AdminProfitLog", "FinancialOperation" RESTART IDENTITY CASCADE'
    );

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        stay = require('../services/stayPaymentService');
        lifecycle = require('../services/reservationLifecycleService');
    });
    afterAll(async () => { await prisma.$disconnect(); });
    beforeEach(truncate, 15000);
    afterEach(truncate, 15000);

    const day = (offset) => {
        const n = new Date();
        return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + offset)).toISOString().slice(0, 10);
    };
    const IN = day(7);
    const OUT = day(9);

    async function seedHotel() {
        const { owner, biz } = await seedBusiness(prisma, { owner: { availableBalance: 0 } });
        await prisma.businessProfile.update({ where: { id: biz.id }, data: { category: 'HOSPITALITY' } });
        const room = await prisma.hotelRoom.create({
            data: {
                businessProfileId: biz.id, roomNumber: '101', roomType: 'DELUXE', capacity: 2,
                basePriceUsdc: 50, amenities: [], imageUrls: [],
            },
        });
        return { owner, biz, room };
    }
    const balances = async (id) => {
        const u = await prisma.user.findUnique({ where: { id }, select: { availableBalance: true, escrowLockedBalance: true } });
        return { available: Number(u.availableBalance), locked: Number(u.escrowLockedBalance) };
    };
    const pay = async (ctx, guest, key) => {
        const p = await stay.priceStay(prisma, { bizId: ctx.biz.bizId, roomId: ctx.room.id, checkInDate: IN, checkOutDate: OUT, partySize: 2 });
        return stay.bookPaidStay(prisma, {
            bizId: ctx.biz.bizId, roomId: ctx.room.id, customerId: guest.id, checkInDate: IN, checkOutDate: OUT,
            partySize: 2, expectedTotalUsdc: p.totalUsdc.toFixed(6), clientRequestKey: key,
        });
    };

    test('H1: pay, confirm, then the QR check-in pays the hotel once', async () => {
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 500 });
        const out = await pay(ctx, guest, 'h1');
        expect(out.reservation.status).toBe('CONFIRMED');
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: out.payment.escrowId } });
        expect(escrow.status).toBe('FUNDED');
        expect(await balances(guest.id)).toEqual({
            available: expect.closeTo(500 - out.payment.totalUsdc, 6),
            locked: expect.closeTo(out.payment.amountUsdc, 6),
        });

        await lifecycle.checkInReservation(prisma, { method: 'QR', reservationId: out.reservation.id, businessUserId: ctx.owner.id, requireFreshClaim: true });
        expect((await prisma.smartEscrow.findUnique({ where: { id: out.payment.escrowId } })).status).toBe('SETTLED');
        expect((await balances(ctx.owner.id)).available).toBeCloseTo(out.payment.amountUsdc, 6);
        expect((await balances(guest.id)).locked).toBeCloseTo(0, 6);
        await expect(lifecycle.checkInReservation(prisma, { method: 'QR', reservationId: out.reservation.id, businessUserId: ctx.owner.id, requireFreshClaim: true }))
            .rejects.toMatchObject({ code: 'RESERVATION_ALREADY_CHECKED_IN' });
        expect((await balances(ctx.owner.id)).available).toBeCloseTo(out.payment.amountUsdc, 6);
    });

    test('H2: a short balance rolls everything back', async () => {
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 5 });
        await expect(pay(ctx, guest, 'h2')).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        expect(await prisma.reservation.count()).toBe(0);
        expect(await prisma.smartEscrow.count()).toBe(0);
        expect(await prisma.ticket.count()).toBe(0);
        expect(await balances(guest.id)).toEqual({ available: 5, locked: 0 });
    });

    test('H3: two guests, one room, same dates: exactly one pays', async () => {
        const ctx = await seedHotel();
        const a = await seedUser(prisma, { availableBalance: 500 });
        const b = await seedUser(prisma, { availableBalance: 500 });
        const outcomes = await Promise.allSettled([pay(ctx, a, 'h3-a'), pay(ctx, b, 'h3-b')]);
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        const refused = outcomes.find((o) => o.status === 'rejected');
        expect(refused.reason).toMatchObject({ code: 'BOOKED' });
        expect(await prisma.reservation.count()).toBe(1);
        expect(await prisma.smartEscrow.count({ where: { status: 'FUNDED' } })).toBe(1);
        const loser = outcomes[0].status === 'rejected' ? a : b;
        expect(await balances(loser.id)).toEqual({ available: 500, locked: 0 });
    });

    test('H4: the hotel cancelling refunds everything, the fee included', async () => {
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 500 });
        const bucket = async () => Number((await prisma.systemProfitFees.findUnique({ where: { id: 1 } }))?.balance ?? 0);
        const out = await pay(ctx, guest, 'h4');
        expect(out.payment.feeUsdc).toBeGreaterThan(0);
        expect(await bucket()).toBeCloseTo(out.payment.feeUsdc, 6);
        await lifecycle.businessCancelReservation(prisma, { reservationId: out.reservation.id, businessProfileId: ctx.biz.id, reason: 'Flooded' });
        expect((await prisma.reservation.findUnique({ where: { id: out.reservation.id } })).status).toBe('CANCELLED_BUSINESS');
        const escrow = await prisma.smartEscrow.findUnique({ where: { id: out.payment.escrowId } });
        expect(escrow.status).toBe('REFUNDED');
        expect(await balances(guest.id)).toEqual({ available: expect.closeTo(500, 6), locked: expect.closeTo(0, 6) });
        expect(await bucket()).toBeCloseTo(0, 6);
        const history = await prisma.transactionHistory.findUnique({ where: { txHash: escrow.refundTxHash } });
        expect(Number(history.amountUsdc)).toBeCloseTo(out.payment.totalUsdc, 6);

        // The fees were withdrawn: the next hotel cancellation still refunds
        // the price, and the fee is recorded as owed.
        const again = await pay(ctx, guest, 'h4-b');
        await prisma.systemProfitFees.update({ where: { id: 1 }, data: { balance: 0 } });
        await lifecycle.businessCancelReservation(prisma, { reservationId: again.reservation.id, businessProfileId: ctx.biz.id, reason: 'Flooded' });
        const owedEscrow = await prisma.smartEscrow.findUnique({ where: { id: again.payment.escrowId } });
        expect(owedEscrow.status).toBe('REFUNDED');
        expect(await balances(guest.id)).toEqual({ available: expect.closeTo(500 - again.payment.feeUsdc, 6), locked: expect.closeTo(0, 6) });
        const owed = await prisma.transactionHistory.findUnique({ where: { txHash: owedEscrow.refundTxHash } });
        expect(owed.metadata).toEqual(expect.objectContaining({ feeRefundedUsdc: 0, feeRefundOwedUsdc: again.payment.feeUsdc }));
        expect(await bucket()).toBe(0);
    });

    test('H5: through the real idempotency middleware: a retry replays, a different stay under the key is refused, a short balance frees the key', async () => {
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 500 });
        const p = await stay.priceStay(prisma, { bizId: ctx.biz.bizId, roomId: ctx.room.id, checkInDate: IN, checkOutDate: OUT, partySize: 2 });
        const { idempotency } = require('../middleware/idempotency');
        const ctrl = require('../controllers/hotelMarketplaceController');
        // The route's own declaration (routes/marketplaceRoutes.js).
        const claim = idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, required: false });
        const ROUTE = '/business/:bizId/reservations';
        const drive = ({ userId, key, body }) => new Promise((resolve, reject) => {
            const settings = { prisma };
            const app = { get: (k) => settings[k] ?? null };
            const headers = { 'idempotency-key': key };
            const req = {
                method: 'POST', baseUrl: '/api/marketplace', route: { path: ROUTE },
                path: `/business/${ctx.biz.bizId}/reservations`,
                originalUrl: `/api/marketplace/business/${ctx.biz.bizId}/reservations`,
                headers, get: (h) => headers[String(h).toLowerCase()],
                params: { bizId: ctx.biz.bizId }, query: {}, body, ip: '127.0.0.1',
                app, user: { id: userId, username: 'guest' },
            };
            const res = {
                app, locals: {}, statusCode: 200, headersSent: false,
                status(c) { this.statusCode = c; return this; },
                json(b) {
                    if (!this.headersSent) {
                        this.headersSent = true;
                        resolve({ status: this.statusCode, body: b === undefined ? undefined : JSON.parse(JSON.stringify(b)) });
                    }
                    return this;
                },
                setHeader() {},
                end() { this.headersSent = true; resolve({ status: this.statusCode, body: null }); return this; },
            };
            claim(req, res, (err) => (err ? reject(err) : Promise.resolve(ctrl.createHotelReservation(req, res)).catch(reject)));
        });
        const body = {
            payWith: 'WALLET', roomId: ctx.room.id, checkInDate: IN, checkOutDate: OUT, partySize: 2,
            expectedTotalUsdc: p.totalUsdc.toFixed(6),
        };

        const first = await drive({ userId: guest.id, key: 'h5-a', body });
        expect(first.status).toBe(201);
        expect(first.body.payment).toEqual(expect.objectContaining({ method: 'WALLET', heldUntil: 'CHECK_IN' }));
        const op = await prisma.financialOperation.findFirst({ where: { userId: guest.id, key: 'h5-a' } });
        expect(op).toEqual(expect.objectContaining({ status: 'COMMITTED', statusCode: 201 }));
        const charged = await balances(guest.id);
        expect(charged.available).toBeCloseTo(500 - p.totalUsdc, 6);

        // The same request again: replayed from the claim, nothing more charged.
        const again = await drive({ userId: guest.id, key: 'h5-a', body });
        expect(again.status).toBe(201);
        expect(again.body.reservation.id).toBe(first.body.reservation.id);
        expect(await prisma.smartEscrow.count()).toBe(1);
        expect(await balances(guest.id)).toEqual(charged);

        // A different stay under the same key: refused, nothing charged.
        const other = await drive({ userId: guest.id, key: 'h5-a', body: { ...body, partySize: 1 } });
        expect(other.status).toBe(409);
        expect(await prisma.reservation.count()).toBe(1);
        expect(await balances(guest.id)).toEqual(charged);

        // A short balance: 402, nothing charged, and the key is free again.
        const poor = await seedUser(prisma, { availableBalance: 5 });
        const later = { ...body, checkInDate: day(14), checkOutDate: day(16) };
        const lp = await stay.priceStay(prisma, { bizId: ctx.biz.bizId, roomId: ctx.room.id, checkInDate: later.checkInDate, checkOutDate: later.checkOutDate, partySize: 2 });
        later.expectedTotalUsdc = lp.totalUsdc.toFixed(6);
        const short = await drive({ userId: poor.id, key: 'h5-b', body: later });
        expect(short.status).toBe(402);
        expect(short.body.code).toBe('INSUFFICIENT_BALANCE');
        expect(await prisma.financialOperation.count({ where: { userId: poor.id, key: 'h5-b' } })).toBe(0);
        expect(await balances(poor.id)).toEqual({ available: 5, locked: 0 });
        // Top up the way money really arrives: balance and its ledger row
        // together (the pre-flight ledger audit, runDoubleCheck, refuses a
        // balance with no history behind it).
        await prisma.$transaction([
            prisma.user.update({ where: { id: poor.id }, data: { availableBalance: 500 } }),
            prisma.transactionHistory.create({ data: { userId: poor.id, type: 'DEPOSIT_CRYPTO', amountUsdc: 495, feeUsdc: 0, status: 'COMPLETED' } }),
        ]);
        const topped = await drive({ userId: poor.id, key: 'h5-b', body: later });
        expect(topped.status).toBe(201);
        expect(await prisma.smartEscrow.count({ where: { status: 'FUNDED' } })).toBe(2);
    });
});
