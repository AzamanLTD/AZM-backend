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
//   H4. The hotel cancelling refunds the price (the fee stays realized).
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

        await lifecycle.checkInReservation(prisma, { reservationId: out.reservation.id, businessUserId: ctx.owner.id, requireFreshClaim: true });
        expect((await prisma.smartEscrow.findUnique({ where: { id: out.payment.escrowId } })).status).toBe('SETTLED');
        expect((await balances(ctx.owner.id)).available).toBeCloseTo(out.payment.amountUsdc, 6);
        expect((await balances(guest.id)).locked).toBeCloseTo(0, 6);
        await expect(lifecycle.checkInReservation(prisma, { reservationId: out.reservation.id, businessUserId: ctx.owner.id, requireFreshClaim: true }))
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

    test('H4: the hotel cancelling refunds the price', async () => {
        const ctx = await seedHotel();
        const guest = await seedUser(prisma, { availableBalance: 500 });
        const out = await pay(ctx, guest, 'h4');
        await lifecycle.businessCancelReservation(prisma, { reservationId: out.reservation.id, businessProfileId: ctx.biz.id, reason: 'Flooded' });
        expect((await prisma.reservation.findUnique({ where: { id: out.reservation.id } })).status).toBe('CANCELLED_BUSINESS');
        expect((await prisma.smartEscrow.findUnique({ where: { id: out.payment.escrowId } })).status).toBe('REFUNDED');
        expect(await balances(guest.id)).toEqual({
            available: expect.closeTo(500 - out.payment.feeUsdc, 6),
            locked: expect.closeTo(0, 6),
        });
    });
});
