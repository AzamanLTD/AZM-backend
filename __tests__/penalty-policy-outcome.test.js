// __tests__/penalty-policy-outcome.test.js
// Business no-show penalty OUTCOMES under the atomic settlement architecture:
// refund + guarded stake claim + booking terminal transition + audit commit in
// ONE $transaction, with the canonical escrow refund primitive.
jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));
jest.mock('../services/escrowService', () => ({
    _refundEscrowTx: jest.fn(),
    refundEscrowInTransaction: jest.fn(),
}));

const escrowService = require('../services/escrowService');
const { processBusinessNoShow } = require('../services/penaltyPolicyService');

const scenario = (escrowId, bookingType) => ({
    escrow: {
        id: escrowId, ticketId: `ticket-${escrowId}`, payerId: 'customer-1',
        payeeId: 'business-user-1', amountUsdc: 100, feeUsdc: 0.5, status: 'FUNDED',
    },
    booking: {
        id: `booking-${escrowId}`, escrowId, businessProfileId: `business-${escrowId}`,
        status: 'CONFIRMED',
    },
});

const makePrisma = ({ stakeClaimCount = 1, escrowStatus = 'FUNDED' } = {}) => {
    const build = (escrowId, bookingType) => {
        const { escrow, booking } = scenario(escrowId, bookingType);
        const model = bookingType === 'RESERVATION' ? 'reservation' : 'transitBooking';
        const tx = {
            smartEscrow: { findUnique: jest.fn().mockResolvedValue({ ...escrow, status: escrowStatus }) },
            [model]: {
                findUnique: jest.fn().mockResolvedValue(booking),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            businessProfile: { updateMany: jest.fn().mockResolvedValue({ count: stakeClaimCount }) },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return { prisma: { $transaction: jest.fn(async (cb) => cb(tx)) }, tx, escrow, booking };
    };
    return build;
};

beforeEach(() => {
    jest.clearAllMocks();
    escrowService._refundEscrowTx.mockImplementation(async (tx, escrow) => ({
        ...escrow, status: 'REFUNDED', refundedAt: new Date(),
    }));
});

describe('business no-show penalty outcomes', () => {
    test('reports and audits an applied penalty via a guarded stake claim', async () => {
        const build = makePrisma();
        const { prisma, tx, booking } = build('escrow-1', 'RESERVATION');

        const result = await processBusinessNoShow(prisma, {
            escrowId: 'escrow-1',
            bookingType: 'RESERVATION',
            bookingId: 'booking-escrow-1',
            businessProfileId: 'business-escrow-1',
            reason: 'business closed',
        });

        expect(result).toEqual(expect.objectContaining({
            refunded: true,
            penaltyApplied: true,
            penaltyAmount: 10,
        }));
        // Guarded conditional claim — never a blind decrement.
        expect(tx.businessProfile.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'business-escrow-1',
                stakeBalance: { gte: 10 },
            },
            data: { stakeBalance: { decrement: 10 } },
        });
        expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                action: 'BUSINESS_NO_SHOW',
                targetType: 'RESERVATION',
                targetId: 'booking-escrow-1',
                metadata: expect.objectContaining({
                    penaltyAmount: 10,
                    penaltyApplied: true,
                }),
            }),
        }));
        // The booking reached the business-no-show terminal state.
        expect(tx.reservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: booking.id, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
            data: expect.objectContaining({ status: 'CANCELLED_BUSINESS' }),
        }));
    });

    test('does not claim a penalty was applied when the guarded claim loses (insufficient stake)', async () => {
        const build = makePrisma({ stakeClaimCount: 0 });
        const { prisma, tx } = build('escrow-2', 'TRANSIT');

        const result = await processBusinessNoShow(prisma, {
            escrowId: 'escrow-2',
            bookingType: 'TRANSIT',
            bookingId: 'booking-escrow-2',
            businessProfileId: 'business-escrow-2',
            reason: 'trip cancelled',
        });

        expect(result).toEqual(expect.objectContaining({
            refunded: true,
            penaltyApplied: false,
            penaltyAmount: 10,
        }));
        // The claim ran (and lost on the guard) — the refund still committed
        // and the audit row records the deterministic outcome.
        expect(tx.businessProfile.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ penaltyApplied: false }),
            }),
        }));
    });

    test('does not swallow a failed escrow refund — the whole settlement rejects', async () => {
        const build = makePrisma();
        const { prisma, tx } = build('escrow-3', 'RESERVATION');
        escrowService._refundEscrowTx.mockRejectedValue(new Error('ESCROW_ALREADY_FINALIZED'));

        await expect(processBusinessNoShow(prisma, {
            escrowId: 'escrow-3',
            bookingType: 'RESERVATION',
            bookingId: 'booking-escrow-3',
            businessProfileId: 'business-escrow-3',
            reason: 'no-show',
        })).rejects.toThrow('ESCROW_ALREADY_FINALIZED');

        expect(tx.businessProfile.updateMany).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
        expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    });
});
