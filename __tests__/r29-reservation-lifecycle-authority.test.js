// r29 P0 — real PostgreSQL proofs for one authoritative reservation
// lifecycle/economic state machine. SKIPS unless TEST_DATABASE_URL is set.
const { seedUser, seedBusiness } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) console.warn('[r29-reservation-lifecycle] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r29 reservation lifecycle economic authority (real PostgreSQL)', () => {
    let prisma, lifecycle, escrowSvc, reservationCtrl;
    let seq = 0;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'r29_test_secret_at_least_32_chars';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        lifecycle = require('../services/reservationLifecycleService');
        escrowSvc = require('../services/bookingEscrowService');
        reservationCtrl = require('../controllers/reservationController');
    });

    afterAll(async () => prisma.$disconnect());
    afterEach(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "r29_fail_history" ON "TransactionHistory"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS r29_fail_history()');
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "TransactionHistory", "SystemProfitFees", "Ticket", "SmartEscrow", "Reservation", "BusinessProduct", "BusinessProfile", "User", "GlobalSettings" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    async function seedReservation({ status = 'CONFIRMED', amount = 40, penaltyPct = null, endPast = false } = {}) {
        const { biz, owner } = await seedBusiness(prisma);
        const customer = await seedUser(prisma, { availableBalance: 500 });
        const reservation = await prisma.reservation.create({
            data: {
                reservationRef: `RES-R29-${Date.now()}-${++seq}`,
                businessProfileId: biz.id,
                customerId: customer.id,
                status,
                startDatetime: new Date(Date.now() - (endPast ? 7200_000 : 1800_000)),
                endDatetime: new Date(Date.now() + (endPast ? -3600_000 : 3600_000)),
                amountUsdc: amount,
                depositUsdc: amount,
                ...(penaltyPct != null ? { noShowPenaltyPct: penaltyPct } : {}),
            },
        });
        return { biz, owner, customer, reservation };
    }

    async function fund(ctx, amount = 40) {
        const { escrow } = await escrowSvc.createBookingEscrow(prisma, {
            bookingType: 'RESERVATION', bookingId: ctx.reservation.id,
            payerId: ctx.customer.id, payeeId: ctx.owner.id,
            amountUsdc: amount, businessProfileId: ctx.biz.id,
        });
        await escrowSvc.fundBookingEscrow(prisma, {
            escrowId: escrow.id, payerId: ctx.customer.id,
            bookingType: 'RESERVATION', bookingId: ctx.reservation.id,
        });
        return escrow.id;
    }

    async function balances(ctx) {
        const [payer, payee] = await Promise.all([
            prisma.user.findUnique({ where: { id: ctx.customer.id } }),
            prisma.user.findUnique({ where: { id: ctx.owner.id } }),
        ]);
        return {
            payerAvailable: Number(payer.availableBalance),
            payerLocked: Number(payer.escrowLockedBalance),
            payeeAvailable: Number(payee.availableBalance),
        };
    }

    async function economicCounts(escrowId) {
        return {
            refunds: await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_REFUND' } }),
            releases: await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_RELEASE' } }),
            refundLedgers: await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:refund:${escrowId}:REFUNDED` } }),
            releaseLedgers: await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:release:${escrowId}:SETTLED` } }),
            splitLedgers: await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:escrow:split-release:${escrowId}` } }),
        };
    }

    function reqRes(userId, reservationId) {
        const req = { user: { id: userId }, params: { reservationId }, body: {}, app: { get: k => k === 'prisma' ? prisma : undefined } };
        const res = { statusCode: 200, payload: null, status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return this; } };
        return { req, res };
    }

    async function installHistoryFailure() {
        await prisma.$executeRawUnsafe(`CREATE FUNCTION r29_fail_history() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'r29 injected history failure'; END; $$ LANGUAGE plpgsql`);
        await prisma.$executeRawUnsafe(`CREATE TRIGGER "r29_fail_history" BEFORE INSERT ON "TransactionHistory" FOR EACH ROW EXECUTE FUNCTION r29_fail_history()`);
    }

    test('A1 pending cancellation without escrow is a state-only terminal transition', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        const result = await lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id });
        expect(result.status).toBe('CANCELLED_CUSTOMER');
        expect(await prisma.transactionHistory.count({ where: { type: { in: ['TICKET_ESCROW_REFUND', 'TICKET_ESCROW_RELEASE'] } } })).toBe(0);
    });

    test('A2 funded cancellation atomically refunds exact principal once; retry is inert', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const funded = await balances(ctx);
        expect(funded.payerLocked).toBeCloseTo(40, 6);

        await lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id });
        await lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id });

        const [reservation, escrow, after, counts] = await Promise.all([
            prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            prisma.smartEscrow.findUnique({ where: { id: escrowId } }),
            balances(ctx), economicCounts(escrowId),
        ]);
        expect(reservation.status).toBe('CANCELLED_CUSTOMER');
        expect(escrow.status).toBe('REFUNDED');
        expect(after.payerLocked).toBeCloseTo(0, 6);
        expect(after.payerAvailable).toBeCloseTo(funded.payerAvailable + 40, 6);
        expect(counts).toMatchObject({ refunds: 1, refundLedgers: 1, releases: 0 });
    });

    test('A3 concurrent cancellation attempts converge with one refund', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const outcomes = await Promise.allSettled([1, 2].map(() => lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id })));
        expect(outcomes.every(x => x.status === 'fulfilled')).toBe(true);
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CANCELLED_CUSTOMER');
        expect(await economicCounts(escrowId)).toMatchObject({ refunds: 1, refundLedgers: 1 });
    });

    test('A4 injected history failure rolls back escrow, balance, ledger and reservation', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const before = await balances(ctx);
        await installHistoryFailure();
        await expect(lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id })).rejects.toThrow('r29 injected');
        const [reservation, escrow, after] = await Promise.all([
            prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            prisma.smartEscrow.findUnique({ where: { id: escrowId } }), balances(ctx),
        ]);
        expect(reservation.status).toBe('CONFIRMED');
        expect(escrow.status).toBe('FUNDED');
        expect(after).toEqual(before);
        expect(await economicCounts(escrowId)).toMatchObject({ refunds: 0, refundLedgers: 0 });
    });

    test('A5 cross-customer cancellation is rejected with zero mutation', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const stranger = await seedUser(prisma);
        const { req, res } = reqRes(stranger.id, ctx.reservation.id);
        await reservationCtrl.cancelReservation(req, res);
        expect(res.statusCode).toBe(404);
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CONFIRMED');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('FUNDED');
    });

    test('A6 terminal reservation cannot acquire a new fundable escrow', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        await lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id });
        await expect(escrowSvc.createBookingEscrow(prisma, {
            bookingType: 'RESERVATION', bookingId: ctx.reservation.id,
            payerId: ctx.customer.id, payeeId: ctx.owner.id,
            amountUsdc: 40, businessProfileId: ctx.biz.id,
        })).rejects.toMatchObject({ code: 'BOOKING_ESCROW_LINK_CONFLICT' });
        expect(await prisma.smartEscrow.count()).toBe(0);
    });

    test('B1 funded check-in atomically settles to business exactly once', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const before = await balances(ctx);
        await lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id });
        const [reservation, escrow, after, counts] = await Promise.all([
            prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            prisma.smartEscrow.findUnique({ where: { id: escrowId } }), balances(ctx), economicCounts(escrowId),
        ]);
        expect(reservation.status).toBe('CHECKED_IN');
        expect(escrow.status).toBe('SETTLED');
        expect(after.payerLocked).toBeCloseTo(0, 6);
        expect(after.payeeAvailable).toBeCloseTo(before.payeeAvailable + 40, 6);
        expect(counts).toMatchObject({ releases: 1, releaseLedgers: 1, refunds: 0 });
    });

    test('B2 injected settlement failure leaves reservation CONFIRMED and retry succeeds', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        await installHistoryFailure();
        await expect(lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id })).rejects.toThrow('r29 injected');
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CONFIRMED');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('FUNDED');
        await prisma.$executeRawUnsafe('DROP TRIGGER "r29_fail_history" ON "TransactionHistory"');
        await lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id });
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CHECKED_IN');
    });

    test('B3 concurrent check-ins produce one settlement', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const outcomes = await Promise.allSettled([1, 2].map(() => lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id })));
        expect(outcomes.every(x => x.status === 'fulfilled')).toBe(true);
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CHECKED_IN');
        expect(await economicCounts(escrowId)).toMatchObject({ releases: 1, releaseLedgers: 1 });
    });

    test('B4 unfunded/no-escrow check-in remains valid and unauthorized business is rejected', async () => {
        const ctx = await seedReservation();
        const stranger = await seedUser(prisma);
        await expect(lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: stranger.id })).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
        const result = await lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id });
        expect(result.status).toBe('CHECKED_IN');
    });

    test('B5 QR check-in uses the same settlement authority', async () => {
        const ctx = await seedReservation();
        const escrowId = await fund(ctx);
        const qr = require('../services/qrCheckInService');
        const token = await qr.generateCheckInToken(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id });
        const result = await qr.verifyAndCheckIn(prisma, { token: token.token, businessUserId: ctx.owner.id });
        expect(result.reservation.status).toBe('CHECKED_IN');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('SETTLED');
    });

    test('C1 configured no-show penalty performs one canonical split', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25, endPast: true });
        const escrowId = await fund(ctx);
        const before = await balances(ctx);
        const result = await lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id });
        const after = await balances(ctx);
        expect(result.status).toBe('NO_SHOW');
        expect(Number(result.penaltyAmountUsdc)).toBeCloseTo(10, 6);
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('RELEASED');
        expect(after.payeeAvailable).toBeCloseTo(before.payeeAvailable + 10, 6);
        expect(after.payerAvailable).toBeCloseTo(before.payerAvailable + 30, 6);
        expect(await economicCounts(escrowId)).toMatchObject({ refunds: 1, releases: 1, splitLedgers: 1 });
    });

    test('C2 no-penalty funded no-show fully refunds instead of stranding custody', async () => {
        const ctx = await seedReservation({ endPast: true });
        const escrowId = await fund(ctx);
        const result = await lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, worker: true });
        expect(result.status).toBe('NO_SHOW');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('REFUNDED');
        expect((await balances(ctx)).payerLocked).toBeCloseTo(0, 6);
        expect(await economicCounts(escrowId)).toMatchObject({ refunds: 1, refundLedgers: 1 });
    });

    test('C3 no-escrow no-show is a legitimate state-only transition', async () => {
        const ctx = await seedReservation({ endPast: true });
        const result = await lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, worker: true });
        expect(result.status).toBe('NO_SHOW');
        expect(await prisma.transactionHistory.count({ where: { type: { in: ['TICKET_ESCROW_REFUND', 'TICKET_ESCROW_RELEASE'] } } })).toBe(0);
    });

    test('C4 worker path refunds a funded no-penalty overdue reservation', async () => {
        const ctx = await seedReservation({ endPast: true });
        const escrowId = await fund(ctx);
        const { sweepNoShowReservations } = require('../workers/reservationNoShowWorker');
        const sweep = await sweepNoShowReservations(prisma);
        expect(sweep).toMatchObject({ processed: 1, penalized: 0, errors: 0 });
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('NO_SHOW');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('REFUNDED');
        expect((await balances(ctx)).payerLocked).toBeCloseTo(0, 6);
    });

    test('C5 disputed escrow remains in custody and reservation stays CONFIRMED', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25, endPast: true });
        const escrowId = await fund(ctx);
        await prisma.smartEscrow.update({ where: { id: escrowId }, data: { status: 'DISPUTED' } });
        await expect(lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, worker: true })).rejects.toMatchObject({ code: 'ESCROW_IN_DISPUTE' });
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CONFIRMED');
        expect((await balances(ctx)).payerLocked).toBeCloseTo(40, 6);
    });

    test('D1 cancellation vs no-show admits exactly one matching terminal economy', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25, endPast: true });
        const escrowId = await fund(ctx);
        await Promise.allSettled([
            lifecycle.cancelReservation(prisma, { reservationId: ctx.reservation.id, customerId: ctx.customer.id }),
            lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, worker: true }),
        ]);
        const [reservation, escrow, counts] = await Promise.all([
            prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            prisma.smartEscrow.findUnique({ where: { id: escrowId } }), economicCounts(escrowId),
        ]);
        expect(['CANCELLED_CUSTOMER', 'NO_SHOW']).toContain(reservation.status);
        expect(reservation.status === 'CANCELLED_CUSTOMER' ? escrow.status : 'RELEASED').toBe(escrow.status);
        expect(counts.refundLedgers + counts.splitLedgers).toBe(1);
    });

    test('D2 check-in vs no-show admits exactly one matching terminal economy', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25, endPast: true });
        const escrowId = await fund(ctx);
        await Promise.allSettled([
            lifecycle.checkInReservation(prisma, { reservationId: ctx.reservation.id, businessUserId: ctx.owner.id }),
            lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, worker: true }),
        ]);
        const [reservation, escrow, counts] = await Promise.all([
            prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            prisma.smartEscrow.findUnique({ where: { id: escrowId } }), economicCounts(escrowId),
        ]);
        expect(['CHECKED_IN', 'NO_SHOW']).toContain(reservation.status);
        expect(reservation.status === 'CHECKED_IN' ? escrow.status : 'RELEASED').toBe(escrow.status);
        expect(counts.releaseLedgers + counts.splitLedgers).toBe(1);
    });

    test('D3 two concurrent no-shows produce one split and one terminal state', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25, endPast: true });
        const escrowId = await fund(ctx);
        const outcomes = await Promise.allSettled([1, 2].map(() => lifecycle.markNoShowReservation(prisma, { reservationId: ctx.reservation.id, worker: true })));
        expect(outcomes.every(x => x.status === 'fulfilled')).toBe(true);
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('NO_SHOW');
        expect(await economicCounts(escrowId)).toMatchObject({ splitLedgers: 1, refunds: 1, releases: 1 });
    });

    test('C6 owner cannot mark no-show before end time and the failed attempt has zero mutation', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25 });
        const escrowId = await fund(ctx);
        const before = {
            reservation: await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            escrow: await prisma.smartEscrow.findUnique({ where: { id: escrowId } }),
            balances: await balances(ctx),
            counts: await economicCounts(escrowId),
        };

        await expect(lifecycle.markNoShowReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessUserId: ctx.owner.id,
        })).rejects.toMatchObject({ code: 'RESERVATION_NOT_NO_SHOW_READY' });

        const after = {
            reservation: await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } }),
            escrow: await prisma.smartEscrow.findUnique({ where: { id: escrowId } }),
            balances: await balances(ctx),
            counts: await economicCounts(escrowId),
        };
        expect(after.reservation.status).toBe('CONFIRMED');
        expect(after.reservation.updatedAt).toEqual(before.reservation.updatedAt);
        expect(after.escrow.status).toBe(before.escrow.status);
        expect(after.balances).toEqual(before.balances);
        expect(after.counts).toEqual(before.counts);
    });

    test('C7 owner no-show after end time with configured penalty splits exactly once', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25, endPast: true });
        const escrowId = await fund(ctx);
        const outcomes = await Promise.allSettled([1, 2].map(() => lifecycle.markNoShowReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessUserId: ctx.owner.id,
        })));
        expect(outcomes.every(result => result.status === 'fulfilled')).toBe(true);
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('NO_SHOW');
        expect(await economicCounts(escrowId)).toMatchObject({ refunds: 1, releases: 1, splitLedgers: 1 });
    });

    test('C8 owner no-show after end time without penalty refunds exactly once', async () => {
        const ctx = await seedReservation({ endPast: true });
        const escrowId = await fund(ctx);
        const outcomes = await Promise.allSettled([1, 2].map(() => lifecycle.markNoShowReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessUserId: ctx.owner.id,
        })));
        expect(outcomes.every(result => result.status === 'fulfilled')).toBe(true);
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('NO_SHOW');
        expect((await prisma.smartEscrow.findUnique({ where: { id: escrowId } })).status).toBe('REFUNDED');
        expect(await economicCounts(escrowId)).toMatchObject({ refunds: 1, refundLedgers: 1 });
    });

    test('C9 rejected early no-show remains eligible for the later worker sweep', async () => {
        const ctx = await seedReservation({ penaltyPct: 0.25 });
        const escrowId = await fund(ctx);
        await expect(lifecycle.markNoShowReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessUserId: ctx.owner.id,
        })).rejects.toMatchObject({ code: 'RESERVATION_NOT_NO_SHOW_READY' });

        await prisma.reservation.update({
            where: { id: ctx.reservation.id },
            data: { endDatetime: new Date(Date.now() - 1000) },
        });
        const { sweepNoShowReservations } = require('../workers/reservationNoShowWorker');
        const sweep = await sweepNoShowReservations(prisma);
        expect(sweep).toMatchObject({ processed: 1, penalized: 1, errors: 0 });
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('NO_SHOW');
        expect(await economicCounts(escrowId)).toMatchObject({ splitLedgers: 1 });
    });

    test('E1 confirmation racing customer cancellation cannot resurrect the cancelled reservation', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        await Promise.allSettled([
            lifecycle.confirmReservation(prisma, {
                reservationId: ctx.reservation.id,
                businessProfileId: ctx.biz.id,
            }),
            lifecycle.cancelReservation(prisma, {
                reservationId: ctx.reservation.id,
                customerId: ctx.customer.id,
            }),
        ]);
        const reservation = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
        expect(reservation.status).toBe('CANCELLED_CUSTOMER');
    });

    test('E2 confirmation is compatible with concurrent escrow creation and funding', async () => {
        const creationCtx = await seedReservation({ status: 'PENDING' });
        const creation = await Promise.all([
            lifecycle.confirmReservation(prisma, {
                reservationId: creationCtx.reservation.id,
                businessProfileId: creationCtx.biz.id,
            }),
            escrowSvc.createBookingEscrow(prisma, {
                bookingType: 'RESERVATION', bookingId: creationCtx.reservation.id,
                payerId: creationCtx.customer.id, payeeId: creationCtx.owner.id,
                amountUsdc: 40, businessProfileId: creationCtx.biz.id,
            }),
        ]);
        expect(creation[0].status).toBe('CONFIRMED');
        expect(creation[1].escrow.status).toBe('DRAFT');

        const fundingCtx = await seedReservation({ status: 'PENDING' });
        const { escrow } = await escrowSvc.createBookingEscrow(prisma, {
            bookingType: 'RESERVATION', bookingId: fundingCtx.reservation.id,
            payerId: fundingCtx.customer.id, payeeId: fundingCtx.owner.id,
            amountUsdc: 40, businessProfileId: fundingCtx.biz.id,
        });
        const funding = await Promise.all([
            lifecycle.confirmReservation(prisma, {
                reservationId: fundingCtx.reservation.id,
                businessProfileId: fundingCtx.biz.id,
            }),
            escrowSvc.fundBookingEscrow(prisma, {
                escrowId: escrow.id, payerId: fundingCtx.customer.id,
                bookingType: 'RESERVATION', bookingId: fundingCtx.reservation.id,
            }),
        ]);
        expect(funding[0].status).toBe('CONFIRMED');
        expect(funding[1].escrow.status).toBe('FUNDED');
    });

    test('E3 repeated concurrent confirmations admit one CAS winner', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        const outcomes = await Promise.allSettled([1, 2].map(() => lifecycle.confirmReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessProfileId: ctx.biz.id,
        })));
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(outcomes.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'RESERVATION_CONFIRM_CONFLICT' });
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CONFIRMED');
    });

    test('E4 stale confirmation after cancellation is rejected without mutation', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        await lifecycle.cancelReservation(prisma, {
            reservationId: ctx.reservation.id,
            customerId: ctx.customer.id,
        });
        const before = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
        await expect(lifecycle.confirmReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessProfileId: ctx.biz.id,
        })).rejects.toMatchObject({ code: 'RESERVATION_CONFIRM_CONFLICT' });
        const after = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
        expect(after.status).toBe('CANCELLED_CUSTOMER');
        expect(after.updatedAt).toEqual(before.updatedAt);
    });

    test('E5 stale confirmation after a later lifecycle transition cannot resurrect state', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        await lifecycle.confirmReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessProfileId: ctx.biz.id,
        });
        await lifecycle.checkInReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessUserId: ctx.owner.id,
        });
        await expect(lifecycle.confirmReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessProfileId: ctx.biz.id,
        })).rejects.toMatchObject({ code: 'RESERVATION_CONFIRM_CONFLICT' });
        expect((await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } })).status).toBe('CHECKED_IN');
    });

    test('E6 cross-business confirmation has zero mutation', async () => {
        const ctx = await seedReservation({ status: 'PENDING' });
        const other = await seedBusiness(prisma);
        const before = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
        await expect(lifecycle.confirmReservation(prisma, {
            reservationId: ctx.reservation.id,
            businessProfileId: other.biz.id,
            businessNotes: 'must not persist',
        })).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
        const after = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
        expect(after.status).toBe('PENDING');
        expect(after.businessNotes).toBe(before.businessNotes);
        expect(after.confirmedAt).toBeNull();
        expect(after.updatedAt).toEqual(before.updatedAt);
    });

});
