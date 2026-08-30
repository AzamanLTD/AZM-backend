jest.mock('../services/escrowService', () => ({
    _refundEscrow: jest.fn(),
}));

const escrowService = require('../services/escrowService');
const EscrowExpiryWorker = require('../workers/escrowExpiryWorker');

describe('EscrowExpiryWorker refund convergence', () => {
    afterEach(() => jest.clearAllMocks());

    test('emits escrow_refunded and balance_update only after refund succeeds', async () => {
        const escrow = {
            id: 'escrow-1',
            ticketId: 'ticket-1',
            payerId: 11,
            payeeId: 22,
            ticket: {
                id: 'ticket-1',
                status: 'OPEN',
                creatorId: 11,
                counterpartyId: 22,
            },
        };
        const refunded = {
            id: 'escrow-1',
            ticketId: 'ticket-1',
            status: 'EXPIRED',
            amountUsdc: 50,
        };

        const emit = jest.fn();
        const io = {
            to: jest.fn(() => ({ emit })),
        };
        const prisma = {
            smartEscrow: {
                findMany: jest.fn().mockResolvedValue([escrow]),
            },
            ticket: {
                update: jest.fn().mockResolvedValue({}),
            },
            ticketMessage: {
                create: jest.fn().mockResolvedValue({ id: 'message-1', type: 'SYSTEM' }),
            },
        };
        escrowService._refundEscrow.mockResolvedValue(refunded);

        const worker = new EscrowExpiryWorker(prisma, io, null);
        await worker._expireInactiveFunded(new Date('2026-08-30T00:00:00.000Z'));

        expect(escrowService._refundEscrow).toHaveBeenCalledWith(prisma, 'escrow-1', 'EXPIRED');
        expect(io.to).toHaveBeenCalledWith('user_11');
        expect(io.to).toHaveBeenCalledWith('user_22');
        expect(io.to).toHaveBeenCalledWith('admin_spy_room');
        expect(emit).toHaveBeenCalledWith('escrow_refunded', expect.objectContaining({
            escrowId: 'escrow-1',
            ticketId: 'ticket-1',
            status: 'EXPIRED',
            reason: 'EXPIRY',
        }));
        expect(emit).toHaveBeenCalledWith('balance_update', {
            userId: 11,
            escrowId: 'escrow-1',
            reason: 'escrow_refunded',
        });
        expect(prisma.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'ticket-1' },
        }));
    });

    test('does not emit financial convergence when the refund transaction fails', async () => {
        const escrow = {
            id: 'escrow-2',
            ticketId: 'ticket-2',
            payerId: 31,
            payeeId: 32,
            ticket: null,
        };
        const emit = jest.fn();
        const io = { to: jest.fn(() => ({ emit })) };
        const prisma = {
            smartEscrow: { findMany: jest.fn().mockResolvedValue([escrow]) },
        };
        escrowService._refundEscrow.mockRejectedValue(new Error('ESCROW_ALREADY_FINALIZED'));

        const worker = new EscrowExpiryWorker(prisma, io, null);
        await worker._expireInactiveFunded(new Date());

        expect(emit).not.toHaveBeenCalled();
    });
});
