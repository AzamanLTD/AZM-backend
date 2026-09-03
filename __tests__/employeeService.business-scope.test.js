const { EmployeeService } = require('../services/businessOS/employeeService');

describe('EmployeeService business scoping', () => {
    test('getEmployee scopes the lookup to the requested business', async () => {
        const prisma = {
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };
        const service = new EmployeeService(prisma);

        await expect(service.getEmployee('employee-b', 'business-a')).resolves.toBeNull();
        expect(prisma.businessEmployee.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'employee-b', businessProfileId: 'business-a' },
        }));
    });

    test('updateEmployee refuses a foreign-business employee before mutation', async () => {
        const prisma = {
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
        };
        const service = new EmployeeService(prisma);

        await expect(service.updateEmployee('employee-b', 'business-a', { title: 'Tampered' }))
            .rejects.toThrow('Employee not found.');
        expect(prisma.businessEmployee.update).not.toHaveBeenCalled();
    });

    test('permission update scopes both read and write to the requested business', async () => {
        const prisma = {
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'employee-a' }),
                update: jest.fn().mockResolvedValue({ id: 'employee-a', permissions: ['view_own_shifts'] }),
            },
        };
        const service = new EmployeeService(prisma);

        await expect(service.updatePermissions('employee-a', 'business-a', ['view_own_shifts']))
            .resolves.toEqual({ id: 'employee-a', permissions: ['view_own_shifts'] });

        expect(prisma.businessEmployee.findFirst).toHaveBeenCalledWith({
            where: { id: 'employee-a', businessProfileId: 'business-a' },
            select: { id: true },
        });
        expect(prisma.businessEmployee.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'employee-a' },
            data: { permissions: ['view_own_shifts'] },
        }));
    });

    test('route-compatible removeEmployee delegates to the scoped terminator', async () => {
        const service = new EmployeeService({});
        jest.spyOn(service, 'terminateEmployee').mockResolvedValue({ id: 'employee-a', status: 'TERMINATED' });

        await expect(service.removeEmployee('employee-a', 'business-a', 'policy violation'))
            .resolves.toEqual({ id: 'employee-a', status: 'TERMINATED' });
        expect(service.terminateEmployee).toHaveBeenCalledWith('employee-a', 'business-a', 'policy violation');
    });

    test('employee stats scopes every tenant-owned relation query', async () => {
        const prisma = {
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({ id: 'employee-a' }),
            },
            shift: { count: jest.fn().mockResolvedValue(8) },
            employeeFeedback: {
                findMany: jest.fn().mockResolvedValue([{ rating: 4, tags: ['great'] }]),
            },
            payrollRecord: {
                findMany: jest.fn().mockResolvedValue([{ grossAmount: 100, netAmount: 90, period: '2026-08', status: 'PROCESSED' }]),
            },
        };
        const service = new EmployeeService(prisma);

        const stats = await service.getEmployeeStats('employee-a', 'business-a');

        expect(stats.totalShifts).toBe(8);
        expect(prisma.shift.count).toHaveBeenCalledWith({
            where: { employeeId: 'employee-a', businessProfileId: 'business-a' },
        });
        expect(prisma.employeeFeedback.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { receiverEmployeeId: 'employee-a', businessProfileId: 'business-a' },
        }));
        expect(prisma.payrollRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { employeeId: 'employee-a', businessProfileId: 'business-a' },
        }));
    });
});
