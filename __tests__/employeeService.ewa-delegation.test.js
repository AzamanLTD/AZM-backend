const { EmployeeService } = require('../services/businessOS/employeeService');
const { EwaService } = require('../services/businessOS/ewaService');

describe('EmployeeService.requestEWA', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('delegates all withdrawal mutations to the canonical EWA service and preserves legacy fields', async () => {
        const requestWithdrawal = jest
            .spyOn(EwaService.prototype, 'requestWithdrawal')
            .mockResolvedValue({
                success: true,
                grossAmount: 50,
                fee: 0.5,
                netToEmployee: 49.5,
                remainingWithdrawable: 25,
                employee: { id: 'employee-1' },
            });

        const service = new EmployeeService({});
        const result = await service.requestEWA('employee-1', 50);

        expect(requestWithdrawal).toHaveBeenCalledTimes(1);
        expect(requestWithdrawal).toHaveBeenCalledWith({
            employeeId: 'employee-1',
            amount: 50,
            destination: 'AZM_BALANCE',
        });
        expect(result).toEqual({
            success: true,
            grossAmount: 50,
            fee: 0.5,
            netToEmployee: 49.5,
            remainingWithdrawable: 25,
            employee: { id: 'employee-1' },
            withdrawn: 50,
            remainingEwa: 25,
        });
    });

    test('does not perform any legacy employee or ledger writes itself', async () => {
        const prisma = {
            businessEmployee: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
            businessLedgerEntry: {
                create: jest.fn(),
            },
        };
        const requestWithdrawal = jest
            .spyOn(EwaService.prototype, 'requestWithdrawal')
            .mockResolvedValue({
                success: true,
                grossAmount: 10,
                fee: 0.1,
                netToEmployee: 9.9,
                remainingWithdrawable: 2,
                employee: { id: 'employee-2' },
            });

        const service = new EmployeeService(prisma);
        await service.requestEWA('employee-2', 10);

        expect(requestWithdrawal).toHaveBeenCalledTimes(1);
        expect(prisma.businessEmployee.findUnique).not.toHaveBeenCalled();
        expect(prisma.businessEmployee.update).not.toHaveBeenCalled();
        expect(prisma.businessLedgerEntry.create).not.toHaveBeenCalled();
    });
});
