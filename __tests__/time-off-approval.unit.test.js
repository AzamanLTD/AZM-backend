const { TimeOffService } = require('../services/businessOS/timeOffService');

describe('TimeOffService approval mutations', () => {
    test('scopes approval to the request business and pending status', async () => {
        const prisma = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ role: 'MANAGER' }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ userId: 12345 }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'emp-manager', businessProfileId: 'biz-1' }),
            },
            timeOffRequest: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ id: 'req-1', businessProfileId: 'biz-1', status: 'PENDING', employeeId: 'emp-2' })
                    .mockResolvedValueOnce({ id: 'req-1', status: 'APPROVED' }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };

        const result = await new TimeOffService(prisma).approveTimeOff('req-1', 99, 'Approved');

        expect(result.status).toBe('APPROVED');
        expect(prisma.businessEmployee.findFirst).toHaveBeenCalledWith({
            where: { userId: 99, businessProfileId: 'biz-1', status: 'ACTIVE' },
            select: { id: true, businessProfileId: true },
        });
        expect(prisma.timeOffRequest.updateMany).toHaveBeenCalledWith({
            where: { id: 'req-1', businessProfileId: 'biz-1', status: 'PENDING' },
            data: { status: 'APPROVED', managerNote: 'Approved' },
        });
    });

    test('rejects a worker attempting to approve their own request', async () => {
        const prisma = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ role: 'USER' }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ userId: 12345 }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'emp-1', businessProfileId: 'biz-1' }),
            },
            timeOffRequest: {
                findUnique: jest.fn().mockResolvedValue({ id: 'req-2', businessProfileId: 'biz-1', status: 'PENDING', employeeId: 'emp-1' }),
            },
        };

        await expect(new TimeOffService(prisma).approveTimeOff('req-2', 11, 'Approve'))
            .rejects.toThrow(/cannot approve their own/i);
    });

    test('fails closed when the approver is not an active employee of the request business', async () => {
        const prisma = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ role: 'USER' }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ userId: 12345 }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            timeOffRequest: {
                findUnique: jest.fn().mockResolvedValue({ id: 'req-other', businessProfileId: 'biz-2', status: 'PENDING', employeeId: 'emp-9' }),
            },
        };

        await expect(new TimeOffService(prisma).approveTimeOff('req-other', 99, 'Approve'))
            .rejects.toThrow(/not authorized/i);
    });

    test('atomically rejects a pending request and scopes the write to its business', async () => {
        const prisma = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ role: 'MANAGER' }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ userId: 12345 }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'emp-manager', businessProfileId: 'biz-7' }),
            },
            timeOffRequest: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ id: 'req-7', businessProfileId: 'biz-7', status: 'PENDING', employeeId: 'emp-worker' })
                    .mockResolvedValueOnce({ id: 'req-7', status: 'REJECTED' }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };

        const result = await new TimeOffService(prisma).rejectTimeOff('req-7', 88, 'Not available');

        expect(result.status).toBe('REJECTED');
        expect(prisma.timeOffRequest.updateMany).toHaveBeenCalledWith({
            where: { id: 'req-7', businessProfileId: 'biz-7', status: 'PENDING' },
            data: { status: 'REJECTED', managerNote: 'Not available' },
        });
    });

    test('fails when the conditional transition loses a concurrent race', async () => {
        const prisma = {
            user: {
                findUnique: jest.fn().mockResolvedValue({ role: 'MANAGER' }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ userId: 12345 }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'emp-manager', businessProfileId: 'biz-3' }),
            },
            timeOffRequest: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'req-race',
                    businessProfileId: 'biz-3',
                    status: 'PENDING',
                    employeeId: 'emp-worker',
                }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
        };

        await expect(new TimeOffService(prisma).approveTimeOff('req-race', 77, 'Approve'))
            .rejects.toThrow(/no longer pending/i);
        expect(prisma.timeOffRequest.findUnique).toHaveBeenCalledTimes(1);
    });
});
