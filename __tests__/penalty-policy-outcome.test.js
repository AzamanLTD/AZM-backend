jest.mock('../services/escrowService', () => ({
    _refundEscrow: jest.fn(),
}));

const escrowService = require('../services/escrowService');
const { processBusinessNoShow } = require('../services/penaltyPolicyService');

describe('business no-show penalty outcomes', () => {
    const makePrisma = ({ stakeBalance = 100 } = {}) => ({
        smartEscrow: {
            findUnique: jest.fn().mockResolvedValue({
                amountUsdc: 100,
                payerId: 'customer-1',
                payeeId: 'business-user-1',
            }),
        },
        businessProfile: {
            findUnique: jest.fn().mockResolvedValue({
                stakeBalance,
                businessName: 'Test Business',
            }),
            update: jest.fn().mockResolvedValue({}),
        },
        auditLog: {
            create: jest.fn().mockResolvedValue({}),
        },
    });

    beforeEach(() => {
        jest.clearAllMocks();
        escrowService._refundEscrow.mockResolvedValue({ refundAmount: 100 });
    });

    test('reports and audits an applied penalty', async () => {
        const prisma = makePrisma({ stakeBalance: 20 });

        const result = await processBusinessNoShow(prisma, {
            escrowId: 'escrow-1',
            bookingType: 'reservation',
            bookingId: 'booking-1',
            businessProfileId: 'business-1',
            reason: 'business closed',
        });

        expect(result).toEqual(expect.objectContaining({
            refunded: true,
            penaltyApplied: true,
            penaltyAmount: 10,
        }));
        expect(prisma.businessProfile.update).toHaveBeenCalledWith({
            where: { id: 'business-1' },
            data: { stakeBalance: { decrement: 10 } },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                action: 'BUSINESS_NO_SHOW',
                metadata: expect.objectContaining({
                    penaltyAmount: 10,
                    penaltyApplied: true,
                }),
            }),
        }));
    });

    test('does not claim a penalty was applied when stake is insufficient', async () => {
        const prisma = makePrisma({ stakeBalance: 5 });

        const result = await processBusinessNoShow(prisma, {
            escrowId: 'escrow-2',
            bookingType: 'transit',
            bookingId: 'booking-2',
            businessProfileId: 'business-2',
            reason: 'trip cancelled',
        });

        expect(result).toEqual(expect.objectContaining({
            refunded: true,
            penaltyApplied: false,
            penaltyAmount: 10,
        }));
        expect(prisma.businessProfile.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ penaltyApplied: false }),
            }),
        }));
    });

    test('does not swallow a failed escrow refund', async () => {
        const prisma = makePrisma();
        escrowService._refundEscrow.mockRejectedValue(new Error('ESCROW_ALREADY_FINALIZED'));

        await expect(processBusinessNoShow(prisma, {
            escrowId: 'escrow-3',
            bookingType: 'reservation',
            bookingId: 'booking-3',
            businessProfileId: 'business-3',
            reason: 'no-show',
        })).rejects.toThrow('ESCROW_ALREADY_FINALIZED');

        expect(prisma.smartEscrow.findUnique).not.toHaveBeenCalled();
        expect(prisma.businessProfile.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});
