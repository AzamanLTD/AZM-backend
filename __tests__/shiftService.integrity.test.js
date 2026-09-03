const { ShiftService } = require('../services/businessOS/shiftService');

describe('ShiftService business ownership integrity', () => {
    const scopedShift = {
        id: 'shift-a',
        businessProfileId: 'business-a',
        employeeId: 'employee-a',
        userId: 'user-a',
        status: 'SCHEDULED',
        startTime: new Date('2026-09-03T08:00:00Z'),
        endTime: new Date('2026-09-03T16:00:00Z'),
    };

    test('updateShift cannot mutate a shift outside the caller business', async () => {
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new ShiftService(prisma);

        await expect(svc.updateShift('shift-other', { notes: 'tampered' }, 'business-a'))
            .rejects.toThrow('Shift not found.');
        expect(prisma.shift.update).not.toHaveBeenCalled();
    });

    test('deleteShift cannot delete a shift outside the caller business', async () => {
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue(null),
                delete: jest.fn(),
            },
        };
        const svc = new ShiftService(prisma);

        await expect(svc.deleteShift('shift-other', 'business-a'))
            .rejects.toThrow('Shift not found.');
        expect(prisma.shift.delete).not.toHaveBeenCalled();
    });

    test('clock-in and clock-out are business scoped at the read boundary', async () => {
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const svc = new ShiftService(prisma);

        await expect(svc.clockIn('shift-other', 'business-a')).rejects.toThrow('Shift not found.');
        await expect(svc.clockOut('shift-other', 'business-a')).rejects.toThrow('Shift not found.');
        expect(prisma.shift.update).not.toHaveBeenCalled();
    });

    test('requestShiftSwap requires both shift and requesting employee to belong to the same business', async () => {
        const prisma = {
            shift: {
                findFirst: jest.fn().mockResolvedValue({ ...scopedShift, businessProfileId: 'business-b' }),
            },
            businessEmployee: { findFirst: jest.fn() },
            shiftSwap: { create: jest.fn() },
        };
        const svc = new ShiftService(prisma);

        await expect(svc.requestShiftSwap({
            businessProfileId: 'business-a',
            shiftId: 'shift-a',
            requestingEmployeeId: 'employee-a',
        })).rejects.toThrow('Shift not found.');
        expect(prisma.shiftSwap.create).not.toHaveBeenCalled();
    });

    test('requestShiftSwap only allows the employee who owns the shift to request it', async () => {
        const prisma = {
            shift: { findFirst: jest.fn().mockResolvedValue(scopedShift) },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'employee-b', userId: 'user-b', businessProfileId: 'business-a', status: 'ACTIVE' }),
            },
            shiftSwap: { create: jest.fn() },
        };
        const svc = new ShiftService(prisma);

        await expect(svc.requestShiftSwap({
            businessProfileId: 'business-a',
            shiftId: 'shift-a',
            requestingEmployeeId: 'employee-b',
        })).rejects.toThrow('You can only request a swap for your own shift.');
        expect(prisma.shiftSwap.create).not.toHaveBeenCalled();
    });

    test('claimShiftSwap rejects foreign business swap, employee, or claiming shift', async () => {
        const prisma = {
            shiftSwap: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
            businessEmployee: { findFirst: jest.fn() },
            shift: { findFirst: jest.fn() },
        };
        const svc = new ShiftService(prisma);

        await expect(svc.claimShiftSwap({
            businessProfileId: 'business-a',
            swapId: 'swap-other',
            claimingEmployeeId: 'employee-a',
            claimingShiftId: 'shift-a',
        })).rejects.toThrow('Swap request not found.');
        expect(prisma.shiftSwap.update).not.toHaveBeenCalled();
    });

    test('approveShiftSwap changes both shifts and swap state inside one serializable transaction', async () => {
        const tx = {
            shiftSwap: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'swap-a',
                    businessProfileId: 'business-a',
                    status: 'PENDING',
                    claimingEmployeeId: 'employee-b',
                    claimingUserId: 'user-b',
                    claimingShiftId: 'shift-b',
                    requestingEmployeeId: 'employee-a',
                    requestingUserId: 'user-a',
                    requestingShift: { ...scopedShift },
                    claimingShift: { ...scopedShift, id: 'shift-b', employeeId: 'employee-b', userId: 'user-b' },
                }),
                update: jest.fn().mockResolvedValue({ id: 'swap-a', status: 'APPROVED' }),
            },
            businessEmployee: {
                findFirst: jest.fn()
                    .mockResolvedValueOnce({ id: 'employee-b', businessProfileId: 'business-a', status: 'ACTIVE' })
                    .mockResolvedValueOnce({ id: 'employee-a', businessProfileId: 'business-a', status: 'ACTIVE' }),
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

        await expect(svc.approveShiftSwap('business-a', 'swap-a', 'approved by manager'))
            .resolves.toMatchObject({ status: 'APPROVED' });
        expect(tx.shift.update).toHaveBeenCalledTimes(2);
        expect(tx.shiftSwap.update).toHaveBeenCalledWith({
            where: { id: 'swap-a' },
            data: {
                status: 'APPROVED',
                managerNote: 'approved by manager',
                respondedAt: expect.any(Date),
            },
        });
    });

    test('approveShiftSwap rejects when the swap has moved to another business', async () => {
        const tx = {
            shiftSwap: { findFirst: jest.fn().mockResolvedValue(null) },
            shift: { update: jest.fn() },
            businessEmployee: { findFirst: jest.fn() },
        };
        const prisma = {
            $transaction: jest.fn(async callback => callback(tx)),
        };
        const svc = new ShiftService(prisma);

        await expect(svc.approveShiftSwap('business-a', 'swap-other', null))
            .rejects.toThrow('Swap not found.');
        expect(tx.shift.update).not.toHaveBeenCalled();
    });
});
