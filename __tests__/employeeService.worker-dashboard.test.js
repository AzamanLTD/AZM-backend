const { EmployeeService } = require('../services/businessOS/employeeService');

describe('EmployeeService worker dashboard attendance state', () => {
    test('includes LATE shifts as current and team-on-duty', async () => {
        const employee = {
            id: 'employee-1',
            userId: 101,
            businessProfileId: 'business-a',
            role: 'STAFF',
            status: 'ACTIVE',
            accruedWages: 100,
            withdrawnEarly: 0,
            payrollType: 'HOURLY',
            hourlyRate: 10,
            totalHours: 8,
            businessProfile: { id: 'business-a', businessName: 'Acme', category: 'RETAIL', logoUrl: null },
        };
        const lateShift = {
            id: 'shift-late',
            employeeId: 'employee-1',
            businessProfileId: 'business-a',
            status: 'LATE',
            startTime: new Date(),
            clockInTime: new Date(),
            shiftLabel: 'Opening',
            employee: { role: 'STAFF', user: { username: 'worker', email: 'worker@example.com' } },
        };
        const upcomingShift = {
            id: 'shift-upcoming',
            employeeId: 'employee-2',
            businessProfileId: 'business-a',
            status: 'SCHEDULED',
            startTime: new Date(Date.now() + 3600000),
            employee: { role: 'STAFF', user: { username: 'next-worker' } },
        };

        const prisma = {
            businessEmployee: { findFirst: jest.fn().mockResolvedValue(employee) },
            shift: {
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce(lateShift)
                    .mockResolvedValueOnce(lateShift)
                    .mockResolvedValueOnce(upcomingShift),
                findMany: jest.fn().mockResolvedValue([lateShift]),
            },
            employeeFeedback: { findMany: jest.fn().mockResolvedValue([]) },
        };

        const service = new EmployeeService(prisma);
        const result = await service.getWorkerDashboard(101);

        expect(result.currentShift).toBe(lateShift);
        expect(result.teamOnDuty).toEqual([
            { name: 'worker', role: 'STAFF', shiftLabel: 'Opening' },
        ]);
        expect(prisma.shift.findFirst.mock.calls[1][0]).toEqual(expect.objectContaining({
            where: {
                employeeId: 'employee-1',
                status: { in: ['CLOCKED_IN', 'LATE'] },
            },
        }));
        expect(prisma.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                businessProfileId: 'business-a',
                status: { in: ['CLOCKED_IN', 'LATE'] },
            },
        }));
    });
});
