const { ShiftService } = require('../services/businessOS/shiftService');
const {
    runWithBusinessRequestContext,
} = require('../src/lib/businessRequestContext');

const bpA = 'business-a';
const bpB = 'business-b';

function withContext(context, fn) {
    return runWithBusinessRequestContext(
        {
            userId: 101,
            businessProfileId: bpA,
            isBusinessOwner: false,
            isAdmin: false,
            ...context,
        },
        fn,
    );
}

describe('ShiftService business scoping and atomicity', () => {
    test('rejects cross-business shift update before mutation', async () => {
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new ShiftService(prisma);

        await withContext({}, async () => {
            await expect(svc.updateShift('shift-b', { notes: 'tamper' }))
                .rejects.toThrow('Shift not found.');
        });

        expect(prisma.shift.findFirst).toHaveBeenCalledWith({
            where: { id: 'shift-b', businessProfileId: bpA },
            select: { id: true },
        });
        expect(prisma.shift.update).not.toHaveBeenCalled();
    });

    test('worker cannot clock another employee in the same business', async () => {
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'shift-a',
                    businessProfileId: bpA,
                    employeeId: 'employee-2',
                    userId: 202,
                    employee: { userId: 202 },
                    status: 'SCHEDULED',
                    startTime: new Date(Date.now() + 60_000),
                }),
                update: jest.fn(),
            },
            businessEmployee: { update: jest.fn() },
        };
        const svc = new ShiftService(prisma);

        await withContext({ userId: 101 }, async () => {
            await expect(svc.clockIn('shift-a'))
                .rejects.toThrow('You can only perform this action for your own employee record.');
        });

        expect(prisma.shift.update).not.toHaveBeenCalled();
    });

    test('rejects a swap request when shift and employee are not in the scoped business', async () => {
        const prisma = {
            shift: { findFirst: jest.fn().mockResolvedValue(null) },
            businessEmployee: { findFirst: jest.fn() },
            shiftSwap: { create: jest.fn() },
        };
        const svc = new ShiftService(prisma);

        await withContext({}, async () => {
            await expect(svc.requestShiftSwap({
                businessProfileId: bpB,
                shiftId: 'shift-b',
                requestingEmployeeId: 'employee-b',
                reason: 'swap',
            })).rejects.toThrow('Shift swap business scope mismatch.');
        });

        expect(prisma.shift.findFirst).not.toHaveBeenCalled();
        expect(prisma.shiftSwap.create).not.toHaveBeenCalled();
    });

    test('claiming a swap requires a same-business employee and claimant identity', async () => {
        const prisma = {
            $transaction: jest.fn(async (callback) => callback(prisma)),
            shiftSwap: {
                findFirst: jest.fn().mockResolvedValue({ id: 'swap-a', businessProfileId: bpA, status: 'PENDING' }),
                update: jest.fn(),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'employee-2',
                    businessProfileId: bpA,
                    userId: 202,
                }),
            },
        };
        const svc = new ShiftService(prisma);

        await withContext({ userId: 101 }, async () => {
            await expect(svc.claimShiftSwap({
                swapId: 'swap-a',
                claimingEmployeeId: 'employee-2',
            })).rejects.toThrow('You can only perform this action for your own employee record.');
        });

        expect(prisma.shiftSwap.update).not.toHaveBeenCalled();
    });

    test('approves a swap as one serializable transaction', async () => {
        const origShift = {
            id: 'shift-a',
            businessProfileId: bpA,
            employeeId: 'employee-1',
        };
        const claimShift = {
            id: 'shift-b',
            businessProfileId: bpA,
            employeeId: 'employee-2',
            status: 'SCHEDULED',
        };
        const tx = {
            shiftSwap: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'swap-a',
                    businessProfileId: bpA,
                    status: 'PENDING',
                    requestingShift: origShift,
                    claimingShift: claimShift,
                    claimingEmployeeId: 'employee-2',
                    requestingEmployeeId: 'employee-1',
                    requestingUserId: 101,
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ id: 'swap-a', status: 'APPROVED' }),
            },
            businessEmployee: {
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce({ id: 'employee-2', userId: 202, status: 'ACTIVE' })
                    .mockResolvedValueOnce({ id: 'employee-1', userId: 101, status: 'ACTIVE' }),
            },
            shift: { update: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            $transaction: jest.fn(async (callback, options) => {
                expect(options).toEqual({ isolationLevel: 'Serializable' });
                return callback(tx);
            }),
        };
        const svc = new ShiftService(prisma);

        await withContext({ isBusinessOwner: true }, async () => {
            await expect(svc.approveShiftSwap('swap-a', 'approved')).resolves.toEqual({ id: 'swap-a', status: 'APPROVED' });
        });

        expect(tx.shiftSwap.updateMany).toHaveBeenCalled();
        expect(tx.shift.update).toHaveBeenCalledTimes(2);
    });

    test('failed second shift mutation prevents swap finalization', async () => {
        const tx = {
            shiftSwap: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'swap-a',
                    businessProfileId: bpA,
                    status: 'PENDING',
                    requestingShift: { id: 'shift-a', businessProfileId: bpA, employeeId: 'employee-1' },
                    claimingShift: { id: 'shift-b', businessProfileId: bpA, employeeId: 'employee-2', status: 'SCHEDULED' },
                    claimingEmployeeId: 'employee-2',
                    requestingEmployeeId: 'employee-1',
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            businessEmployee: {
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce({ id: 'employee-2', userId: 202, status: 'ACTIVE' })
                    .mockResolvedValueOnce({ id: 'employee-1', userId: 101, status: 'ACTIVE' }),
            },
            shift: {
                update: jest.fn()
                    .mockResolvedValueOnce({})
                    .mockRejectedValueOnce(new Error('second mutation failed')),
            },
        };
        const prisma = {
            $transaction: jest.fn(async (callback) => callback(tx)),
        };
        const svc = new ShiftService(prisma);

        await withContext({ isBusinessOwner: true }, async () => {
            await expect(svc.approveShiftSwap('swap-a')).rejects.toThrow('second mutation failed');
        });
        expect(tx.shiftSwap.updateMany).not.toHaveBeenCalled();
    });
});
