// r25+r29 integration proofs. These are genuine PostgreSQL races between
// booking funding and the authoritative reservation lifecycle.
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) console.warn('[r30-r25-r29-integration] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r25+r29 booking funding/lifecycle integration (real PostgreSQL)', () => {
    let prisma, escrowSvc, lifecycle;
    let seq = 0;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'r30_integration_secret_at_least_32_chars';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        escrowSvc = require('../services/bookingEscrowService');
        lifecycle = require('../services/reservationLifecycleService');
    });

    afterAll(async () => prisma.$disconnect());
    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "TransactionHistory", "SystemProfitFees", "Ticket", "SmartEscrow", "Reservation", "BusinessProduct", "BusinessProfile", "User", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    async function seedDraft({ status, endPast = false, penaltyPct = null }) {
        const { biz, owner } = await seedBusiness(prisma);
        const customer = await seedUser(prisma, { availableBalance: 500, escrowLockedBalance: 0 });
        const reservation = await prisma.reservation.create({
            data: {
                reservationRef: `RES-R30-${Date.now()}-${++seq}`,
                businessProfileId: biz.id,
                customerId: customer.id,
                status,
                startDatetime: new Date(Date.now() - (endPast ? 7200_000 : 1800_000)),
                endDatetime: new Date(Date.now() + (endPast ? -3600_000 : 3600_000)),
                amountUsdc: 40,
                depositUsdc: 40,
                ...(penaltyPct != null ? { noShowPenaltyPct: penaltyPct } : {}),
            },
        });
        const { escrow } = await escrowSvc.createBookingEscrow(prisma, {
            bookingType: 'RESERVATION',
            bookingId: reservation.id,
            payerId: customer.id,
            payeeId: owner.id,
            amountUsdc: 40,
            businessProfileId: biz.id,
        });
        return { biz, owner, customer, reservation, escrow };
    }

    const fund = (ctx) => escrowSvc.fundBookingEscrow(prisma, {
        escrowId: ctx.escrow.id,
        payerId: ctx.customer.id,
        bookingType: 'RESERVATION',
        bookingId: ctx.reservation.id,
    });

    async function snapshot(ctx) {
        const [reservation, escrow, payer, payee, fundHistory, refundHistory, releaseHistory, fundLedger, refundLedger, releaseLedger, splitLedger] = await Promise.all([
            prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            prisma.smartEscrow.findUnique({ where: { id: ctx.escrow.id } }),
            prisma.user.findUnique({ where: { id: ctx.customer.id } }),
            prisma.user.findUnique({ where: { id: ctx.owner.id } }),
            prisma.transactionHistory.count({ where: { userId: ctx.customer.id, type: 'TICKET_ESCROW_FUND' } }),
            prisma.transactionHistory.count({ where: { userId: ctx.customer.id, type: 'TICKET_ESCROW_REFUND' } }),
            prisma.transactionHistory.count({ where: { userId: ctx.owner.id, type: 'TICKET_ESCROW_RELEASE' } }),
            prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:fund:${ctx.escrow.id}` } }),
            prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:refund:${ctx.escrow.id}:REFUNDED` } }),
            prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:release:${ctx.escrow.id}:SETTLED` } }),
            prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:split-release:${ctx.escrow.id}` } }),
        ]);
        return {
            reservation, escrow, payer, payee,
            counts: { fundHistory, refundHistory, releaseHistory, fundLedger, refundLedger, releaseLedger, splitLedger },
        };
    }

    function expectExactlyOnceBounds(state) {
        for (const value of Object.values(state.counts)) expect(value).toBeLessThanOrEqual(1);
        expect(state.counts.fundHistory).toBe(state.counts.fundLedger);
        expect(Number(state.payer.escrowLockedBalance)).toBeGreaterThanOrEqual(0);
    }

    test('A fundBookingEscrow vs cancellation cannot commit CANCELLED_CUSTOMER + FUNDED', async () => {
        const ctx = await seedDraft({ status: 'PENDING' });
        const outcomes = await Promise.allSettled([
            fund(ctx),
            lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id }),
        ]);
        expect(outcomes.some(x => x.status === 'fulfilled')).toBe(true);

        const state = await snapshot(ctx);
        expectExactlyOnceBounds(state);
        if (state.reservation.status === 'CANCELLED_CUSTOMER') {
            expect(['EXPIRED', 'REFUNDED']).toContain(state.escrow.status);
        } else {
            expect(state.reservation.status).toBe('CONFIRMED');
            expect(state.escrow.status).toBe('FUNDED');
        }
        expect(state.reservation.status === 'CANCELLED_CUSTOMER' && state.escrow.status === 'FUNDED').toBe(false);
    });

    test('B fundBookingEscrow vs check-in cannot commit CHECKED_IN + refunded/actively-funded escrow', async () => {
        const ctx = await seedDraft({ status: 'CONFIRMED' });
        const outcomes = await Promise.allSettled([
            fund(ctx),
            lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id }),
        ]);
        expect(outcomes.some(x => x.status === 'fulfilled')).toBe(true);

        const state = await snapshot(ctx);
        expectExactlyOnceBounds(state);
        if (state.reservation.status === 'CHECKED_IN') {
            expect(['EXPIRED', 'SETTLED']).toContain(state.escrow.status);
        } else {
            expect(state.reservation.status).toBe('CONFIRMED');
            expect(state.escrow.status).toBe('FUNDED');
        }
        expect(state.reservation.status === 'CHECKED_IN' && ['FUNDED', 'REFUNDED'].includes(state.escrow.status)).toBe(false);
    });

    test('C fundBookingEscrow vs no-show cannot commit NO_SHOW + FUNDED escrow', async () => {
        const ctx = await seedDraft({ status: 'CONFIRMED', endPast: true, penaltyPct: 0.25 });
        const outcomes = await Promise.allSettled([
            fund(ctx),
            lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id }),
        ]);
        expect(outcomes.some(x => x.status === 'fulfilled')).toBe(true);

        const state = await snapshot(ctx);
        expectExactlyOnceBounds(state);
        if (state.reservation.status === 'NO_SHOW') {
            expect(['EXPIRED', 'RELEASED']).toContain(state.escrow.status);
        } else {
            expect(state.reservation.status).toBe('CONFIRMED');
            expect(state.escrow.status).toBe('FUNDED');
        }
        expect(state.reservation.status === 'NO_SHOW' && state.escrow.status === 'FUNDED').toBe(false);
    });

    test('D stale funding against a terminal reservation rolls back escrow, balances, ledger and history', async () => {
        const ctx = await seedDraft({ status: 'PENDING' });
        await prisma.reservation.update({
            where: { id: ctx.reservation.id },
            data: { status: 'CANCELLED_CUSTOMER', cancelledAt: new Date() },
        });
        const payerBefore = await prisma.user.findUnique({ where: { id: ctx.customer.id } });

        await expect(fund(ctx)).rejects.toMatchObject({ code: 'RESERVATION_FUNDING_CONFLICT' });

        const state = await snapshot(ctx);
        expect(state.reservation.status).toBe('CANCELLED_CUSTOMER');
        expect(state.escrow.status).toBe('DRAFT');
        expect(Number(state.payer.availableBalance)).toBe(Number(payerBefore.availableBalance));
        expect(Number(state.payer.escrowLockedBalance)).toBe(Number(payerBefore.escrowLockedBalance));
        expect(state.counts).toEqual({
            fundHistory: 0, refundHistory: 0, releaseHistory: 0,
            fundLedger: 0, refundLedger: 0, releaseLedger: 0, splitLedger: 0,
        });
    });
});
