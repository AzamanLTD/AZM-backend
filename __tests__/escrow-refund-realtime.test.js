jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn() }));

const escrowService = require('../services/escrowService');

describe('escrowService _refundEscrow realtime convergence', () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };

    beforeEach(() => {
        jest.clearAllMocks();
        escrowService.setSocketIO(io);
    });

    test('emits escrow_refunded only after the atomic refund transaction commits', async () => {
        const updated = {
            id: 'escrow-1', ticketId: 'ticket-1', payerId: 11, payeeId: 22,
            status: 'EXPIRED', amountUsdc: 50,
        };
        const escrow = { ...updated, status: 'FUNDED' };
        const tx = {
            smartEscrow: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue(updated),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            smartEscrow: { findUnique: jest.fn().mockResolvedValue(escrow) },
            $transaction: jest.fn(async (callback) => callback(tx)),
        };

        await escrowService._refundEscrow(prisma, 'escrow-1', 'EXPIRED');

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledTimes(3);
        expect(io.to).toHaveBeenNthCalledWith(1, 'user_11');
        expect(io.to).toHaveBeenNthCalledWith(2, 'user_22');
        expect(io.to).toHaveBeenNthCalledWith(3, 'admin_spy_room');
        expect(emit).toHaveBeenCalledWith('escrow_refunded', expect.objectContaining({
            escrowId: 'escrow-1', ticketId: 'ticket-1', status: 'EXPIRED', reason: 'EXPIRY',
        }));
    });

    test('does not emit when the atomic refund transaction fails', async () => {
        const escrow = {
            id: 'escrow-2', ticketId: 'ticket-2', payerId: 31, payeeId: 32,
            status: 'FUNDED', amountUsdc: 75,
        };
        const prisma = {
            smartEscrow: { findUnique: jest.fn().mockResolvedValue(escrow) },
            $transaction: jest.fn().mockRejectedValue(new Error('ESCROW_ALREADY_FINALIZED')),
        };

        await expect(escrowService._refundEscrow(prisma, 'escrow-2', 'EXPIRED'))
            .rejects.toThrow('ESCROW_ALREADY_FINALIZED');
        expect(emit).not.toHaveBeenCalled();
        expect(io.to).not.toHaveBeenCalled();
    });
});