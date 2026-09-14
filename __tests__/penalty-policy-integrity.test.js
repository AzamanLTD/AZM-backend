// P0 — booking/business no-show settlement integrity.
// Contract tests for the business no-show boundary. Production code must use
// the canonical escrow refund lifecycle, guard business-stake debits, and write
// the repository's actual AuditLog schema.

jest.mock('../services/escrowService', () => ({
    _refundEscrow: jest.fn(),
}));

const escrowService = require('../services/escrowService');
const penaltyPolicyService = require('../services/penaltyPolicyService');

const makePrisma = () => ({
    smartEscrow: { findUnique: jest.fn() },
    businessProfile: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
});

describe('business no-show integrity contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        escrowService._refundEscrow.mockResolvedValue({
            escrow: { id: 'escrow-1', status: 'REFUNDED' },
            refundAmount: 100,
        });
    });

    test('refunds through canonical escrow service with a valid lifecycle status, not a reason string', async () => {
        const prisma = makePrisma();
        prisma.smartEscrow.findUnique.mockResolvedValue({ amountUsdc: 100, payerId: 1, payeeId: 2 });
        prisma.businessProfile.findUnique.mockResolvedValue({ stakeBalance: 50, businessName: 'Test Business' });
        prisma.businessProfile.update.mockResolvedValue({});
        prisma.auditLog.create.mockResolvedValue({});

        await penaltyPolicyService.processBusinessNoShow(prisma, {
            escrowId: 'escrow-1',
            bookingType: 'reservation',
            bookingId: 'reservation-1',
            businessProfileId: 'business-1',
            reason: 'Business cancelled after confirmation',
        });

        expect(escrowService._refundEscrow).toHaveBeenCalledWith(prisma, 'escrow-1', 'REFUNDED');
    });

    test('writes the canonical AuditLog field contract', async () => {
        const prisma = makePrisma();
        prisma.smartEscrow.findUnique.mockResolvedValue({ amountUsdc: 100, payerId: 1, payeeId: 2 });
        prisma.businessProfile.findUnique.mockResolvedValue({ stakeBalance: 50, businessName: 'Test Business' });
        prisma.businessProfile.update.mockResolvedValue({});
        prisma.auditLog.create.mockResolvedValue({});

        await penaltyPolicyService.processBusinessNoShow(prisma, {
            escrowId: 'escrow-1',
            bookingType: 'reservation',
            bookingId: 'reservation-1',
            businessProfileId: 'business-1',
            reason: 'Business cancelled after confirmation',
        });

        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'BUSINESS_NO_SHOW',
                targetType: 'RESERVATION',
                targetId: 'reservation-1',
                actorId: null,
                metadata: expect.objectContaining({
                    businessProfileId: 'business-1',
                    escrowId: 'escrow-1',
                    reason: 'Business cancelled after confirmation',
                }),
            }),
        });
    });

    test('business stake debit is conditional and cannot race below zero', async () => {
        const prisma = makePrisma();
        prisma.smartEscrow.findUnique.mockResolvedValue({ amountUsdc: 100, payerId: 1, payeeId: 2 });
        prisma.businessProfile.findUnique.mockResolvedValue({ stakeBalance: 20, businessName: 'Test Business' });
        prisma.businessProfile.updateMany.mockResolvedValue({ count: 1 });
        prisma.auditLog.create.mockResolvedValue({});

        await penaltyPolicyService.processBusinessNoShow(prisma, {
            escrowId: 'escrow-1',
            bookingType: 'reservation',
            bookingId: 'reservation-1',
            businessProfileId: 'business-1',
            reason: 'Business cancelled after confirmation',
        });

        expect(prisma.businessProfile.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'business-1',
                    stakeBalance: expect.objectContaining({ gte: expect.any(Number) }),
                }),
            })
        );
    });
});
