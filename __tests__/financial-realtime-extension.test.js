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

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));
const exactKeys = (value) => Object.keys(value).sort();

const makeIo = (emit) => ({
    to: jest.fn(() => ({ emit })),
});

describe('financial realtime extension contracts', () => {
    afterEach(() => jest.clearAllMocks());

    test('escrow_refunded targets both participants and admin with the EXPIRY semantic', async () => {
        const emit = jest.fn();
        const io = makeIo(emit);
        escrowService.setSocketIO(io);

        const updated = {
            id: 'escrow-refund-1',
            ticketId: 'ticket-refund-1',
            payerId: 101,
            payeeId: 202,
            status: 'EXPIRED',
            amountUsdc: 50,
        };
        const escrow = { ...updated, status: 'FUNDED' };
        let transactionCommitted = false;
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
            $transaction: jest.fn(async callback => {
                const result = await callback(tx);
                transactionCommitted = true;
                return result;
            }),
        };

        await escrowService._refundEscrow(prisma, 'escrow-refund-1', 'EXPIRED');
        await flushMicrotasks();

        expect(transactionCommitted).toBe(true);
        expect(io.to.mock.calls.map(([room]) => room)).toEqual([
            'user_101',
            'user_202',
            'admin_spy_room',
        ]);
        const refundCalls = emit.mock.calls.filter(([event]) => event === 'escrow_refunded');
        expect(refundCalls).toHaveLength(3);
        expect(exactKeys(refundCalls[0][1])).toEqual([
            'amountUsdc',
            'escrowId',
            'payeeId',
            'payerId',
            'reason',
            'status',
            'ticketId',
        ]);
        expect(refundCalls[0][1]).toEqual(expect.objectContaining({
            escrowId: 'escrow-refund-1',
            ticketId: 'ticket-refund-1',
            status: 'EXPIRED',
            amountUsdc: 50,
            payerId: 101,
            payeeId: 202,
            reason: 'EXPIRY',
        }));
    });

    test('escrow_refunded is not emitted when the atomic refund transaction fails', async () => {
        const emit = jest.fn();
        const io = makeIo(emit);
        escrowService.setSocketIO(io);

        const prisma = {
            smartEscrow: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'escrow-refund-2',
                    ticketId: 'ticket-refund-2',
                    payerId: 303,
                    payeeId: 404,
                    status: 'FUNDED',
                    amountUsdc: 75,
                }),
            },
            $transaction: jest.fn().mockRejectedValue(new Error('ESCROW_ALREADY_FINALIZED')),
        };

        await expect(escrowService._refundEscrow(prisma, 'escrow-refund-2', 'EXPIRED'))
            .rejects.toThrow('ESCROW_ALREADY_FINALIZED');
        expect(emit).not.toHaveBeenCalled();
        expect(io.to).not.toHaveBeenCalled();
    });

    test('escrow_pending_settlement emits only after the committed state update', async () => {
        const emit = jest.fn((event, payload) => {
            if (event === 'escrow_pending_settlement') {
                expect(stateUpdateComplete).toBe(true);
                expect(payload.status).toBe('PENDING_SETTLEMENT');
            }
        });
        const io = makeIo(emit);
        escrowService.setSocketIO(io);

        let stateUpdateComplete = false;
        const escrow = {
            id: 'escrow-pending-1',
            ticketId: 'ticket-pending-1',
            payerId: 11,
            payeeId: 22,
            status: 'FUNDED',
            amountUsdc: 100,
            payerSatisfied: false,
            payeeSatisfied: false,
        };
        const pending = {
            ...escrow,
            status: 'PENDING_SETTLEMENT',
            payerSatisfied: true,
            payeeSatisfied: false,
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(escrow)
                    .mockResolvedValueOnce(pending),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                update: jest.fn(async () => {
                    stateUpdateComplete = true;
                    return pending;
                }),
            },
        };

        const result = await escrowService.markSatisfied(prisma, {
            escrowId: escrow.id,
            userId: escrow.payerId,
        });
        await flushMicrotasks();

        expect(result.settled).toBe(false);
        expect(io.to.mock.calls.map(([room]) => room)).toEqual([
            'user_11',
            'user_22',
            'admin_spy_room',
        ]);
        const pendingCalls = emit.mock.calls.filter(([event]) => event === 'escrow_pending_settlement');
        expect(pendingCalls).toHaveLength(3);
        expect(exactKeys(pendingCalls[0][1])).toEqual([
            'amountUsdc',
            'escrowId',
            'payeeId',
            'payerId',
            'status',
            'ticketId',
        ]);
        expect(pendingCalls[0][1]).toEqual(expect.objectContaining({
            escrowId: 'escrow-pending-1',
            ticketId: 'ticket-pending-1',
            status: 'PENDING_SETTLEMENT',
            amountUsdc: 100,
            payerId: 11,
            payeeId: 22,
        }));
    });

    test('escrow_pending_settlement is suppressed when the second satisfied party causes settlement', async () => {
        const emit = jest.fn();
        const io = makeIo(emit);
        escrowService.setSocketIO(io);

        const initial = {
            id: 'escrow-pending-2',
            ticketId: 'ticket-pending-2',
            payerId: 11,
            payeeId: 22,
            status: 'PENDING_SETTLEMENT',
            amountUsdc: 100,
            payerSatisfied: true,
            payeeSatisfied: false,
        };
        const afterClaim = { ...initial, payerSatisfied: true, payeeSatisfied: true };
        const settled = { ...afterClaim, status: 'SETTLED' };
        const tx = {
            smartEscrow: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue(settled),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            smartEscrow: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(initial)
                    .mockResolvedValueOnce(afterClaim)
                    .mockResolvedValueOnce(afterClaim),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            $transaction: jest.fn(async callback => callback(tx)),
        };

        const result = await escrowService.markSatisfied(prisma, {
            escrowId: initial.id,
            userId: initial.payeeId,
        });
        await flushMicrotasks();

        expect(result.settled).toBe(true);
        expect(emit.mock.calls.filter(([event]) => event === 'escrow_pending_settlement')).toHaveLength(0);
        expect(emit.mock.calls.filter(([event]) => event === 'escrow_settled')).toHaveLength(3);
    });
});
