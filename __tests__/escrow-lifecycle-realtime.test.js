jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn() }));
jest.mock('../services/businessOrderService', () => ({
    updateOrderStatusFromEscrow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/bizNotificationService', () => ({
    notifyOrderEvent: jest.fn().mockResolvedValue(undefined),
}));

const escrowService = require('../services/escrowService');

describe('escrowService fundEscrow realtime convergence', () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };

    beforeEach(() => {
        jest.clearAllMocks();
        escrowService.setSocketIO(io);
    });

    test('emits escrow_funded only after the atomic fund transaction commits', async () => {
        const updatedEscrow = {
            id: 'escrow-1', ticketId: 'ticket-1', payerId: 11, payeeId: 22,
            status: 'FUNDED', amountUsdc: 100,
        };
        const escrow = { ...updatedEscrow, status: 'DRAFT', feeUsdc: 5 };
        const tx = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ availableBalance: 200 }),
                update: jest.fn().mockResolvedValue({}),
            },
            smartEscrow: {
                update: jest.fn().mockResolvedValue(updatedEscrow),
            },
            systemProfitFees: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            adminProfitLog: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            smartEscrow: { findUnique: jest.fn().mockResolvedValue(escrow) },
            globalSettings: { findUnique: jest.fn().mockResolvedValue({ escrowFundedExpiryDays: 30 }) },
            $transaction: jest.fn(async (callback) => callback(tx)),
        };

        await escrowService.fundEscrow(prisma, { escrowId: 'escrow-1', payerId: 11 });

        await new Promise(resolve => setImmediate(resolve));

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledTimes(3);
        expect(io.to).toHaveBeenNthCalledWith(1, 'user_11');
        expect(io.to).toHaveBeenNthCalledWith(2, 'user_22');
        expect(io.to).toHaveBeenNthCalledWith(3, 'admin_spy_room');
        expect(emit).toHaveBeenCalledWith('escrow_funded', expect.objectContaining({
            escrowId: 'escrow-1', ticketId: 'ticket-1', status: 'FUNDED',
        }));
    });

    test('does not emit when the fund transaction fails', async () => {
        const escrow = {
            id: 'escrow-2', ticketId: 'ticket-2', payerId: 31, payeeId: 32,
            status: 'DRAFT', amountUsdc: 50, feeUsdc: 5,
        };
        const prisma = {
            smartEscrow: { findUnique: jest.fn().mockResolvedValue(escrow) },
            globalSettings: { findUnique: jest.fn().mockResolvedValue({ escrowFundedExpiryDays: 30 }) },
            $transaction: jest.fn().mockRejectedValue(new Error('Insufficient balance')),
        };

        await expect(escrowService.fundEscrow(prisma, { escrowId: 'escrow-2', payerId: 31 }))
            .rejects.toThrow('Insufficient balance');
        expect(emit).not.toHaveBeenCalled();
    });
});

describe('escrowService markSatisfied realtime convergence (pending settlement)', () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };

    beforeEach(() => {
        jest.clearAllMocks();
        escrowService.setSocketIO(io);
    });

    test('emits escrow_pending_settlement when one party satisfies but not both', async () => {
        const escrow = {
            id: 'escrow-3', ticketId: 'ticket-3', payerId: 11, payeeId: 22,
            status: 'FUNDED', amountUsdc: 100,
            payerSatisfied: false, payeeSatisfied: false,
        };
        const pendingEscrow = {
            id: 'escrow-3', ticketId: 'ticket-3', payerId: 11, payeeId: 22,
            status: 'PENDING_SETTLEMENT', amountUsdc: 100,
            payerSatisfied: true, payeeSatisfied: false,
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(escrow)
                    .mockResolvedValueOnce(pendingEscrow),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                update: jest.fn().mockResolvedValue(pendingEscrow),
            },
        };

        const result = await escrowService.markSatisfied(prisma, { escrowId: 'escrow-3', userId: 11 });

        await new Promise(resolve => setImmediate(resolve));

        expect(result.settled).toBe(false);
        expect(emit).toHaveBeenCalledTimes(3);
        expect(emit).toHaveBeenCalledWith('escrow_pending_settlement', expect.objectContaining({
            escrowId: 'escrow-3', status: 'PENDING_SETTLEMENT',
        }));
    });

    test('does not emit escrow_pending_settlement when both parties satisfy (settles instead)', async () => {
        const escrow = {
            id: 'escrow-4', ticketId: 'ticket-4', payerId: 11, payeeId: 22,
            status: 'FUNDED', amountUsdc: 100,
            payerSatisfied: true, payeeSatisfied: false,
        };
        const afterClaim = {
            id: 'escrow-4', ticketId: 'ticket-4', payerId: 11, payeeId: 22,
            status: 'FUNDED', amountUsdc: 100,
            payerSatisfied: true, payeeSatisfied: true,
        };
        const settledEscrow = {
            id: 'escrow-4', ticketId: 'ticket-4', payerId: 11, payeeId: 22,
            status: 'SETTLED', amountUsdc: 100,
        };
        const tx = {
            smartEscrow: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue(settledEscrow),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(escrow)       // initial load
                    .mockResolvedValueOnce(afterClaim)   // after claim
                    // _releaseEscrow will also call findUnique
                    .mockResolvedValueOnce(afterClaim),  // _releaseEscrow's initial load
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            $transaction: jest.fn(async (callback) => callback(tx)),
        };

        const result = await escrowService.markSatisfied(prisma, { escrowId: 'escrow-4', userId: 22 });

        await new Promise(resolve => setImmediate(resolve));

        expect(result.settled).toBe(true);
        const pendingCalls = emit.mock.calls.filter(c => c[0] === 'escrow_pending_settlement');
        expect(pendingCalls).toHaveLength(0);
        // escrow_settled should have been emitted by _releaseEscrow
        const settledCalls = emit.mock.calls.filter(c => c[0] === 'escrow_settled');
        expect(settledCalls.length).toBeGreaterThan(0);
    });
});

describe('escrowService _releaseEscrow realtime convergence (settled)', () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };

    beforeEach(() => {
        jest.clearAllMocks();
        escrowService.setSocketIO(io);
    });

    test('emits escrow_settled when finalStatus is SETTLED', async () => {
        const escrow = {
            id: 'escrow-5', ticketId: 'ticket-5', payerId: 11, payeeId: 22,
            status: 'PENDING_SETTLEMENT', amountUsdc: 100,
        };
        const updated = {
            id: 'escrow-5', ticketId: 'ticket-5', payerId: 11, payeeId: 22,
            status: 'SETTLED', amountUsdc: 100,
        };
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

        await escrowService._releaseEscrow(prisma, 'escrow-5', 'SETTLED');

        await new Promise(resolve => setImmediate(resolve));

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledTimes(3);
        expect(io.to).toHaveBeenNthCalledWith(1, 'user_11');
        expect(io.to).toHaveBeenNthCalledWith(2, 'user_22');
        expect(io.to).toHaveBeenNthCalledWith(3, 'admin_spy_room');
        expect(emit).toHaveBeenCalledWith('escrow_settled', expect.objectContaining({
            escrowId: 'escrow-5', status: 'SETTLED',
        }));
    });

    test('does not emit escrow_settled when finalStatus is RELEASED (dispute)', async () => {
        const escrow = {
            id: 'escrow-6', ticketId: 'ticket-6', payerId: 11, payeeId: 22,
            status: 'DISPUTED', amountUsdc: 100,
        };
        const updated = {
            id: 'escrow-6', ticketId: 'ticket-6', payerId: 11, payeeId: 22,
            status: 'RELEASED', amountUsdc: 100,
        };
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

        await escrowService._releaseEscrow(prisma, 'escrow-6', 'RELEASED');

        await new Promise(resolve => setImmediate(resolve));

        const settledCalls = emit.mock.calls.filter(c => c[0] === 'escrow_settled');
        expect(settledCalls).toHaveLength(0);
    });

    test('does not emit when the release transaction fails', async () => {
        const escrow = {
            id: 'escrow-7', ticketId: 'ticket-7', payerId: 11, payeeId: 22,
            status: 'FUNDED', amountUsdc: 100,
        };
        const prisma = {
            smartEscrow: { findUnique: jest.fn().mockResolvedValue(escrow) },
            $transaction: jest.fn().mockRejectedValue(new Error('ESCROW_ALREADY_FINALIZED')),
        };

        await expect(escrowService._releaseEscrow(prisma, 'escrow-7', 'SETTLED'))
            .rejects.toThrow('ESCROW_ALREADY_FINALIZED');
        expect(emit).not.toHaveBeenCalled();
    });
});
