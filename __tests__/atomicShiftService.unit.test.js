const { AtomicShiftService } = require('../services/businessOS/atomicShiftService');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

const context = {
    userId: 101,
    businessProfileId: 'biz-1',
    isBusinessOwner: true,
    isAdmin: false,
};

const withContext = (fn, overrides = {}) => runWithBusinessRequestContext({ ...context, ...overrides }, fn);

describe('AtomicShiftService state transitions', () => {
    test('clock-in accepts only SCHEDULED and increments lateness once', async () => {
        const tx = {
            shift: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ id: 'shift-1', status: 'LATE' }),
            },
            businessEmployee: { update: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'shift-1', businessProfileId: 'biz-1', status: 'SCHEDULED',
                    startTime: new Date(Date.now() - 60_000), employeeId: 'emp-1',
                    employee: { userId: 101 },
                }),
            },
            $transaction: jest.fn(async callback => callback(tx)),
        };
        const result = await withContext(() => new AtomicShiftService(prisma).clockIn('shift-1'));

        expect(result.status).toBe('LATE');
        expect(tx.shift.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: 'SCHEDULED', businessProfileId: 'biz-1' }),
        }));
        expect(tx.businessEmployee.update).toHaveBeenCalledTimes(1);
    });

    test('clock-out conditionally closes the shift before applying employee totals', async () => {
        const tx = {
            shift: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'shift-2', businessProfileId: 'biz-1', status: 'CLOCKED_IN',
                    clockInTime: new Date(Date.now() - 3_600_000), breakMinutes: 0,
                    employee: { userId: 101, payrollType: 'HOURLY', hourlyRate: 20 },
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ id: 'shift-2', status: 'CLOCKED_OUT' }),
            },
            businessEmployee: { update: jest.fn().mockResolvedValue({}) },
        };
        const prisma = { $transaction: jest.fn(async callback => callback(tx)) };

        const result = await withContext(() => new AtomicShiftService(prisma).clockOut('shift-2'));

        expect(result.shift.status).toBe('CLOCKED_OUT');
        expect(tx.shift.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: { in: ['CLOCKED_IN', 'LATE'] } }),
        }));
        expect(tx.businessEmployee.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ totalShifts: { increment: 1 } }),
        }));
    });

    test('losing the conditional transition prevents duplicate no-show accounting', async () => {
        const tx = {
            shift: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'shift-3', businessProfileId: 'biz-1', status: 'SCHEDULED',
                    endTime: new Date(Date.now() - 60_000), employeeId: 'emp-1',
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                findUnique: jest.fn(),
            },
            businessEmployee: { update: jest.fn() },
        };
        const prisma = { $transaction: jest.fn(async callback => callback(tx)) };

        await expect(withContext(() => new AtomicShiftService(prisma).markNoShow('shift-3')))
            .rejects.toThrow(/already resolved/i);
        expect(tx.businessEmployee.update).not.toHaveBeenCalled();
    });

    test('swap claim is a conditional write in the same transaction as its validation', async () => {
        const tx = {
            shiftSwap: {
                findFirst: jest.fn().mockResolvedValue({ id: 'swap-1', businessProfileId: 'biz-1', status: 'OPEN' }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ id: 'swap-1', claimingEmployeeId: 'emp-2' }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'emp-2', userId: 101, businessProfileId: 'biz-1' }),
            },
        };
        const prisma = { $transaction: jest.fn(async callback => callback(tx)) };

        const result = await withContext(() => new AtomicShiftService(prisma).claimShiftSwap({
            swapId: 'swap-1',
            claimingEmployeeId: 'emp-2',
        }));

        expect(result.claimingEmployeeId).toBe('emp-2');
        expect(tx.shiftSwap.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: { in: ['PENDING', 'OPEN'] }, businessProfileId: 'biz-1' }),
        }));
    });
});
