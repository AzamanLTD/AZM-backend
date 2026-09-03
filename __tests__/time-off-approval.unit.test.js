jest.mock('../src/lib/businessRequestContext', () => ({
    getBusinessRequestContext: jest.fn(),
}));

const { getBusinessRequestContext } = require('../src/lib/businessRequestContext');
const { TimeOffService } = require('../services/businessOS/timeOffService');

const context = {
    businessProfileId: 'biz-1',
    userId: 99,
    isAdmin: false,
    isBusinessOwner: true,
};

describe('TimeOffService approval mutations', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getBusinessRequestContext.mockReturnValue(context);
    });

    test('scopes approval to the active business and pending status', async () => {
        const prisma = {
            timeOffRequest: {
                findFirst: jest.fn().mockResolvedValue({ id: 'req-1', status: 'PENDING', employeeId: 'emp-2' }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ id: 'req-1', status: 'APPROVED' }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };

        const result = await new TimeOffService(prisma).approveTimeOff('req-1', 99, 'Approved');

        expect(result.status).toBe('APPROVED');
        expect(prisma.timeOffRequest.findFirst).toHaveBeenCalledWith({
            where: { id: 'req-1', businessProfileId: 'biz-1' },
            select: { id: true, status: true, employeeId: true },
        });
        expect(prisma.timeOffRequest.updateMany).toHaveBeenCalledWith({
            where: { id: 'req-1', businessProfileId: 'biz-1', status: 'PENDING' },
            data: { status: 'APPROVED', managerNote: 'Approved' },
        });
    });

    test('rejects a worker attempting to approve their own request', async () => {
        getBusinessRequestContext.mockReturnValue({
            ...context,
            isBusinessOwner: false,
            userId: 11,
        });
        const prisma = {
            timeOffRequest: {
                findFirst: jest.fn().mockResolvedValue({ id: 'req-2', status: 'PENDING', employeeId: 'emp-1' }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'emp-1' }),
            },
        };

        await expect(new TimeOffService(prisma).approveTimeOff('req-2', 11, 'Approve'))
            .rejects.toThrow(/cannot approve their own/i);
    });

    test('fails closed when the target request is outside the business scope', async () => {
        const prisma = {
            timeOffRequest: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };

        await expect(new TimeOffService(prisma).approveTimeOff('req-other', 99, 'Approve'))
            .rejects.toThrow(/not found/i);
        expect(prisma.timeOffRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req-other', businessProfileId: 'biz-1' },
        }));
    });
});
