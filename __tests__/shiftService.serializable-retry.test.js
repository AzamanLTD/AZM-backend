const { ShiftService } = require('../services/businessOS/shiftService');
const {
    runWithBusinessRequestContext,
} = require('../src/lib/businessRequestContext');

describe('ShiftService Serializable retry', () => {
    test('retries a transient P2034 approval conflict and succeeds', async () => {
        const tx = {
            shiftSwap: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'swap-a',
                    businessProfileId: 'business-a',
                    status: 'PENDING',
                    requestingShift: {
                        id: 'shift-a',
                        businessProfileId: 'business-a',
                        employeeId: 'employee-1',
                    },
                    claimingShift: {
                        id: 'shift-b',
                        businessProfileId: 'business-a',
                        employeeId: 'employee-2',
                        status: 'SCHEDULED',
                    },
                    claimingEmployeeId: 'employee-2',
                    requestingEmployeeId: 'employee-1',
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
            shift: {
                update: jest.fn().mockResolvedValue({}),
            },
        };

        const serializationConflict = Object.assign(
            new Error('Transaction failed due to a write conflict or a deadlock.'),
            { code: 'P2034' },
        );
        const prisma = {
            $transaction: jest
                .fn()
                .mockRejectedValueOnce(serializationConflict)
                .mockImplementationOnce(async (callback, options) => {
                    expect(options).toEqual({ isolationLevel: 'Serializable' });
                    return callback(tx);
                }),
        };
        const svc = new ShiftService(prisma);

        await runWithBusinessRequestContext(
            {
                userId: 101,
                businessProfileId: 'business-a',
                isBusinessOwner: true,
                isAdmin: false,
            },
            async () => {
                await expect(svc.approveShiftSwap('swap-a')).resolves.toEqual({
                    id: 'swap-a',
                    status: 'APPROVED',
                });
            },
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(tx.shift.update).toHaveBeenCalledTimes(2);
        expect(tx.shiftSwap.updateMany).toHaveBeenCalledTimes(1);
    });

    test('does not retry non-serialization failures', async () => {
        const error = new Error('permission denied');
        const prisma = {
            $transaction: jest.fn().mockRejectedValue(error),
        };
        const svc = new ShiftService(prisma);

        await runWithBusinessRequestContext(
            {
                userId: 101,
                businessProfileId: 'business-a',
                isBusinessOwner: true,
                isAdmin: false,
            },
            async () => {
                await expect(svc.approveShiftSwap('swap-a')).rejects.toBe(error);
            },
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
});
