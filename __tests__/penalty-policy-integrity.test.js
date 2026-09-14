// __tests__/penalty-policy-integrity.test.js
// =============================================================================
// P0 — booking/business no-show settlement integrity.
//
// Two layers:
//  1. Mocked contract tests (always run) pin the TARGET architecture: the
//     settlement runs in ONE $transaction, the escrow refund goes through the
//     canonical transaction-scoped escrowService primitive with the REFUNDED
//     lifecycle status (never a human-readable reason string), the business
//     stake debit is a guarded conditional claim, the audit row uses the
//     repository's real AuditLog field contract, and caller-supplied IDs are
//     verified against the escrow-linked booking.
//  2. Real-PostgreSQL tests (run when TEST_DATABASE_URL is set — the CI
//     pipeline provides it) prove the atomicity/idempotency invariants against
//     the actual transaction boundary.
// =============================================================================

jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));
jest.mock('../services/escrowService', () => ({
    // The no-show flow must reuse the canonical transaction-scoped primitive —
    // it must NEVER open its own escrow refund or reimplement money movement.
    _refundEscrowTx: jest.fn(),
    refundEscrowInTransaction: jest.fn(),
}));

const escrowService = require('../services/escrowService');
const penaltyPolicyService = require('../services/penaltyPolicyService');

const ESCROW = {
    id: 'escrow-1', ticketId: 'ticket-1', payerId: 10, payeeId: 20,
    amountUsdc: 100, feeUsdc: 0.5, status: 'FUNDED',
};
const RESERVATION = {
    id: 'booking-1', escrowId: 'escrow-1', businessProfileId: 'business-1',
    status: 'CONFIRMED', customerId: 10,
};

const makeTx = (overrides = {}) => ({
    smartEscrow: {
        findUnique: jest.fn().mockResolvedValue(ESCROW),
    },
    reservation: {
        findUnique: jest.fn().mockResolvedValue(RESERVATION),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    transitBooking: {
        findUnique: jest.fn().mockResolvedValue(RESERVATION),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    businessProfile: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
        create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
});

const makePrisma = (tx) => ({
    $transaction: jest.fn(async (cb) => cb(tx)),
});

const CALL = {
    escrowId: 'escrow-1',
    bookingType: 'reservation',
    bookingId: 'booking-1',
    businessProfileId: 'business-1',
    reason: 'Business cancelled after confirmation',
};

beforeEach(() => {
    jest.clearAllMocks();
    escrowService._refundEscrowTx.mockResolvedValue({ ...ESCROW, status: 'REFUNDED' });
});

describe('business no-show settlement contract', () => {
    test('refunds through the canonical transaction-scoped primitive with the REFUNDED lifecycle status, not a reason string', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);

        const result = await penaltyPolicyService.processBusinessNoShow(prisma, CALL);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(escrowService._refundEscrowTx).toHaveBeenCalledTimes(1);
        const [, escrowArg, statusArg] = escrowService._refundEscrowTx.mock.calls[0];
        expect(escrowArg).toMatchObject({ id: 'escrow-1', status: 'FUNDED' });
        expect(statusArg).toBe('REFUNDED');
        expect(typeof statusArg).toBe('string');
        expect(result.refunded).toBe(true);
    });

    test('the settlement transaction composes refund, stake claim, booking transition and audit on the SAME transaction client', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);

        await penaltyPolicyService.processBusinessNoShow(prisma, CALL);

        // Refund primitive receives the tx client.
        expect(escrowService._refundEscrowTx.mock.calls[0][0]).toBe(tx);
        // Stake claim runs on the tx client.
        expect(tx.businessProfile.updateMany).toHaveBeenCalledTimes(1);
        // Booking terminal transition runs on the tx client.
        expect(tx.reservation.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.reservation.updateMany.mock.calls[0][0].where.status).toEqual({
            in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'],
        });
        expect(tx.reservation.updateMany.mock.calls[0][0].data.status).toBe('CANCELLED_BUSINESS');
        // Audit row is written inside the SAME transaction.
        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    test('writes the canonical AuditLog field contract', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);

        await penaltyPolicyService.processBusinessNoShow(prisma, CALL);

        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'BUSINESS_NO_SHOW',
                targetType: 'RESERVATION',
                targetId: 'booking-1',
                actorId: null,
                metadata: expect.objectContaining({
                    businessProfileId: 'business-1',
                    escrowId: 'escrow-1',
                    reason: 'Business cancelled after confirmation',
                    refundAmount: 100,
                    penaltyPct: 0.10,
                }),
            }),
        });
    });

    test('business stake debit is a guarded conditional claim, not a read-compare-decrement', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);

        await penaltyPolicyService.processBusinessNoShow(prisma, CALL);

        expect(tx.businessProfile.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'business-1',
                    stakeBalance: expect.objectContaining({ gte: expect.any(Number) }),
                }),
                data: expect.objectContaining({
                    stakeBalance: expect.objectContaining({ decrement: expect.any(Number) }),
                }),
            })
        );
    });

    test('rejects a bookingId that is not linked to the escrow, before any financial mutation', async () => {
        const tx = makeTx({
            reservation: {
                findUnique: jest.fn().mockResolvedValue({ ...RESERVATION, escrowId: 'escrow-OTHER' }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        });
        const prisma = makePrisma(tx);

        await expect(penaltyPolicyService.processBusinessNoShow(prisma, CALL))
            .rejects.toThrow('BOOKING_ESCROW_MISMATCH');

        expect(escrowService._refundEscrowTx).not.toHaveBeenCalled();
        expect(tx.businessProfile.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    test('rejects a businessProfileId that does not own the booking', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);

        await expect(penaltyPolicyService.processBusinessNoShow(prisma, {
            ...CALL, businessProfileId: 'business-OTHER',
        })).rejects.toThrow('BUSINESS_MISMATCH');

        expect(escrowService._refundEscrowTx).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    test('a replay against an already-refunded escrow converges without any mutation', async () => {
        const tx = makeTx({
            smartEscrow: { findUnique: jest.fn().mockResolvedValue({ ...ESCROW, status: 'REFUNDED' }) },
        });
        const prisma = makePrisma(tx);

        const result = await penaltyPolicyService.processBusinessNoShow(prisma, CALL);

        expect(result.alreadyProcessed).toBe(true);
        expect(result.refunded).toBe(true);
        expect(escrowService._refundEscrowTx).not.toHaveBeenCalled();
        expect(tx.businessProfile.updateMany).not.toHaveBeenCalled();
        expect(tx.reservation.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

// =============================================================================
// REAL POSTGRESQL — atomicity/idempotency proofs against the actual
// transaction boundary. CI provides TEST_DATABASE_URL + a freshly db-pushed
// schema; locally these skip when no database is configured.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[penalty-policy-integrity.test] TEST_DATABASE_URL not set — skipping real-PostgreSQL layer.');
}

describeOrSkip('business no-show settlement (real PostgreSQL)', () => {
    const { seedUser, seedBusiness, seedEscrowTicket } = require('./helpers/factories');
    let prisma;
    let service;

    beforeAll(() => {
        // The contract layer above mocks escrowService; this layer needs the
        // REAL transaction-scoped refund primitive against a real database.
        jest.dontMock('../services/escrowService');
        jest.resetModules();
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        service = require('../services/penaltyPolicyService');
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog", "AuditLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const seedNoShowScenario = async ({
        amount = 100, stake = 0, bookingStatus = 'CONFIRMED', bookingType = 'RESERVATION',
        payerLockedOverride = null,
    } = {}) => {
        const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED', { amountUsdc: amount });
        const { owner, biz } = await seedBusiness(prisma, { stakeBalance: stake });

        let booking;
        if (bookingType === 'RESERVATION') {
            booking = await prisma.reservation.create({
                data: {
                    reservationRef: `RES-TEST-${escrow.id.slice(0, 8)}`,
                    businessProfileId: biz.id,
                    customerId: payer.id,
                    startDatetime: new Date(Date.now() + 24 * 3600 * 1000),
                    endDatetime: new Date(Date.now() + 48 * 3600 * 1000),
                    amountUsdc: amount,
                    depositUsdc: 0,
                    status: bookingStatus,
                    escrowId: escrow.id,
                },
            });
        } else {
            booking = await prisma.transitBooking.create({
                data: {
                    bookingRef: `TRN-TEST-${escrow.id.slice(0, 8)}`,
                    businessProfileId: biz.id,
                    customerId: payer.id,
                    pickupAddress: 'Test Pickup',
                    dropoffAddress: 'Test Dropoff',
                    amountUsdc: amount,
                    status: bookingStatus,
                    escrowId: escrow.id,
                },
            });
        }

        if (payerLockedOverride != null) {
            await prisma.user.update({
                where: { id: payer.id },
                data: { escrowLockedBalance: payerLockedOverride },
            });
        }

        return { payer, payee, escrow, biz, owner, booking };
    };

    const call = (s) => service.processBusinessNoShow(prisma, {
        escrowId: s.escrow.id,
        bookingType: s.booking ? (s.booking.reservationRef ? 'reservation' : 'transit') : 'RESERVATION',
        bookingId: s.booking.id,
        businessProfileId: s.biz.id,
        reason: 'Business cancelled after confirmation',
    });

    test('1. business no-show performs the full settlement: refund, penalty claim, terminal booking, audit', async () => {
        const s = await seedNoShowScenario({ amount: 100, stake: 50 });
        const payerBefore = Number((await prisma.user.findUnique({ where: { id: s.payer.id } })).availableBalance);

        const result = await call(s);

        expect(result.refunded).toBe(true);
        expect(result.penaltyApplied).toBe(true);
        expect(result.penaltyAmount).toBeCloseTo(10, 6);

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: s.escrow.id } });
        expect(escrowAfter.status).toBe('REFUNDED');
        expect(escrowAfter.refundedAt).not.toBeNull();

        const payerAfter = await prisma.user.findUnique({ where: { id: s.payer.id } });
        expect(Number(payerAfter.availableBalance)).toBeCloseTo(payerBefore + 100, 6);
        expect(Number(payerAfter.escrowLockedBalance)).toBeCloseTo(0, 6);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(40, 6);

        const bookingAfter = await prisma.reservation.findUnique({ where: { id: s.booking.id } });
        expect(bookingAfter.status).toBe('CANCELLED_BUSINESS');
        expect(bookingAfter.cancelledAt).not.toBeNull();
    });

    test('2. sufficient stake: penalty is claimed exactly once (deterministic 10% of principal)', async () => {
        const s = await seedNoShowScenario({ amount: 250, stake: 100 });

        await call(s);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(75, 6);
    });

    test('3. insufficient stake: refund still commits and the penalty is not applied (transit path)', async () => {
        const s = await seedNoShowScenario({ amount: 100, stake: 5, bookingType: 'TRANSIT' });

        const result = await call(s);

        expect(result.refunded).toBe(true);
        expect(result.penaltyApplied).toBe(false);

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: s.escrow.id } });
        expect(escrowAfter.status).toBe('REFUNDED');

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(5, 6);

        const bookingAfter = await prisma.transitBooking.findUnique({ where: { id: s.booking.id } });
        expect(bookingAfter.status).toBe('CANCELLED');
    });

    test('4. concurrent business no-show calls: exactly one refund commits', async () => {
        const s = await seedNoShowScenario({ amount: 100, stake: 50 });
        const payerBefore = Number((await prisma.user.findUnique({ where: { id: s.payer.id } })).availableBalance);

        const outcomes = await Promise.allSettled([call(s), call(s)]);

        // Exactly one call performed the settlement. The loser either lost
        // the escrow claim (rejected ESCROW_ALREADY_FINALIZED) or converged
        // via alreadyProcessed — both are correct, and NEITHER moved money.
        const settled = outcomes.filter(
            (o) => o.status === 'fulfilled' && o.value.alreadyProcessed !== true
        );
        expect(settled).toHaveLength(1);

        const payerAfter = await prisma.user.findUnique({ where: { id: s.payer.id } });
        // Credited EXACTLY once — the loser performed no financial mutation.
        expect(Number(payerAfter.availableBalance)).toBeCloseTo(payerBefore + 100, 6);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(40, 6);

        const auditRows = await prisma.auditLog.count({ where: { action: 'BUSINESS_NO_SHOW' } });
        expect(auditRows).toBe(1);
    });

    test('5. concurrent penalty claims can never take the stake below zero', async () => {
        // Two escrows for the SAME business, stake 15, penalty 10 each — only
        // one claim can fit.
        const s1 = await seedNoShowScenario({ amount: 100, stake: 15 });
        const s2 = await seedNoShowScenario({ amount: 100, stake: 0 });
        // Re-point s2's escrow at the same business via its own booking.
        s2.biz = s1.biz;
        await prisma.reservation.update({
            where: { id: s2.booking.id },
            data: { businessProfileId: s1.biz.id },
        });

        await Promise.allSettled([call(s1), call(s2)]);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s1.biz.id } });
        const stake = Number(bizAfter.stakeBalance);
        expect(stake).toBeGreaterThanOrEqual(0);
        // One 10-unit claim fit into the 15-unit stake; the other was refused.
        expect(stake).toBeCloseTo(5, 6);
    });

    test('6. unexpected financial failure rolls back the entire settlement', async () => {
        // Payer's escrow bucket is short of the principal — the canonical
        // refund primitive fails INSIDE the settlement transaction.
        const s = await seedNoShowScenario({ amount: 100, stake: 50, payerLockedOverride: 1 });

        await expect(call(s)).rejects.toThrow('ESCROW_BUCKET_INSUFFICIENT');

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: s.escrow.id } });
        expect(escrowAfter.status).toBe('FUNDED');

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(50, 6);

        const bookingAfter = await prisma.reservation.findUnique({ where: { id: s.booking.id } });
        expect(bookingAfter.status).toBe('CONFIRMED');

        const auditRows = await prisma.auditLog.count({ where: { action: 'BUSINESS_NO_SHOW' } });
        expect(auditRows).toBe(0);
    });

    test('7. booking terminal transition failure rolls back refund, stake penalty and audit', async () => {
        // Booking already CHECKED_OUT — cannot reach the business-no-show
        // terminal state, so the whole settlement must roll back.
        const s = await seedNoShowScenario({ amount: 100, stake: 50, bookingStatus: 'CHECKED_OUT' });

        await expect(call(s)).rejects.toThrow('BOOKING_NOT_TRANSITIONABLE');

        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: s.escrow.id } });
        expect(escrowAfter.status).toBe('FUNDED');

        const payerAfter = await prisma.user.findUnique({ where: { id: s.payer.id } });
        expect(Number(payerAfter.availableBalance)).toBeCloseTo(0, 6);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(50, 6);

        const bookingAfter = await prisma.reservation.findUnique({ where: { id: s.booking.id } });
        expect(bookingAfter.status).toBe('CHECKED_OUT');

        const auditRows = await prisma.auditLog.count({ where: { action: 'BUSINESS_NO_SHOW' } });
        expect(auditRows).toBe(0);
    });

    test('8. the canonical AuditLog row is persisted with the repository field contract', async () => {
        const s = await seedNoShowScenario({ amount: 100, stake: 50 });

        await call(s);

        const auditRow = await prisma.auditLog.findFirst({ where: { action: 'BUSINESS_NO_SHOW' } });
        expect(auditRow).not.toBeNull();
        expect(auditRow.actorId).toBeNull();
        expect(auditRow.action).toBe('BUSINESS_NO_SHOW');
        expect(auditRow.targetType).toBe('RESERVATION');
        expect(auditRow.targetId).toBe(s.booking.id);
        expect(auditRow.metadata.businessProfileId).toBe(s.biz.id);
        expect(auditRow.metadata.escrowId).toBe(s.escrow.id);
        expect(Number(auditRow.metadata.refundAmount)).toBeCloseTo(100, 6);
        expect(Number(auditRow.metadata.penaltyAmount)).toBeCloseTo(10, 6);
        expect(auditRow.metadata.penaltyApplied).toBe(true);
        expect(Number(auditRow.metadata.penaltyPct)).toBeCloseTo(0.10, 6);
    });

    test('9. replay after a committed settlement performs zero additional financial mutation', async () => {
        const s = await seedNoShowScenario({ amount: 100, stake: 50 });

        const first = await call(s);
        const payerAfterFirst = await prisma.user.findUnique({ where: { id: s.payer.id } });
        const snapshot = {
            available: Number(payerAfterFirst.availableBalance),
            locked: Number(payerAfterFirst.escrowLockedBalance),
        };

        const second = await call(s);
        expect(second.alreadyProcessed).toBe(true);
        expect(second.penaltyApplied).toBe(false);
        expect(second.penaltyAmount).toBe(0);

        const payerAfterSecond = await prisma.user.findUnique({ where: { id: s.payer.id } });
        expect(Number(payerAfterSecond.availableBalance)).toBeCloseTo(snapshot.available, 6);
        expect(Number(payerAfterSecond.escrowLockedBalance)).toBeCloseTo(snapshot.locked, 6);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(40, 6);

        // No duplicate penalty audit row on replay.
        const auditRows = await prisma.auditLog.count({ where: { action: 'BUSINESS_NO_SHOW' } });
        expect(auditRows).toBe(1);

        expect(first.alreadyProcessed).toBe(false);
    });

    test('10. cross-booking and cross-business input mismatches are rejected without mutation', async () => {
        const s = await seedNoShowScenario({ amount: 100, stake: 50 });
        const other = await seedNoShowScenario({ amount: 80, stake: 0 });

        // bookingId belongs to a different escrow.
        await expect(service.processBusinessNoShow(prisma, {
            escrowId: s.escrow.id,
            bookingType: 'RESERVATION',
            bookingId: other.booking.id,
            businessProfileId: s.biz.id,
            reason: 'mismatch',
        })).rejects.toThrow('BOOKING_ESCROW_MISMATCH');

        // businessProfileId does not own the booking.
        await expect(service.processBusinessNoShow(prisma, {
            escrowId: s.escrow.id,
            bookingType: 'RESERVATION',
            bookingId: s.booking.id,
            businessProfileId: other.biz.id,
            reason: 'mismatch',
        })).rejects.toThrow('BUSINESS_MISMATCH');

        // Nothing was mutated by either rejected call.
        const escrowAfter = await prisma.smartEscrow.findUnique({ where: { id: s.escrow.id } });
        expect(escrowAfter.status).toBe('FUNDED');

        const payerAfter = await prisma.user.findUnique({ where: { id: s.payer.id } });
        expect(Number(payerAfter.availableBalance)).toBeCloseTo(0, 6);

        const bizAfter = await prisma.businessProfile.findUnique({ where: { id: s.biz.id } });
        expect(Number(bizAfter.stakeBalance)).toBeCloseTo(50, 6);

        const auditRows = await prisma.auditLog.count({ where: { action: 'BUSINESS_NO_SHOW' } });
        expect(auditRows).toBe(0);
    });
});
