const { PayrollService } = require('../services/businessOS/payrollService');

describe('Payroll period snapshot guard', () => {
    const makeTransaction = (tx) => jest.fn(async (callback) => callback(tx));

    test('blocks disbursement when a new clocked-out shift appears after processing', async () => {
        const tx = {
            payrollRecord: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'payroll-1',
                    businessProfileId: 'business-a',
                    employeeId: 'employee-1',
                    userId: 7,
                    period: '2026-08',
                    status: 'PENDING',
                    netAmount: 100,
                    totalHours: 8,
                    breakdown: { shifts: 1 },
                    ewaDeduction: 0,
                    employee: {
                        businessProfileId: 'business-a',
                        withdrawnEarly: 0,
                        smartRouteId: null,
                    },
                }),
                update: jest.fn(),
            },
            shift: {
                findMany: jest.fn().mockResolvedValue([
                    { actualMinutes: 480, breakMinutes: 0 },
                    { actualMinutes: 240, breakMinutes: 0 },
                ]),
            },
            user: { update: jest.fn() },
            transactionHistory: { create: jest.fn() },
            businessLedgerEntry: { create: jest.fn() },
            businessEmployee: { update: jest.fn() },
        };
        const service = new PayrollService({ $transaction: makeTransaction(tx) });

        await expect(service.disbursePayroll('payroll-1', 'business-a'))
            .rejects.toThrow('changed after processing; reprocess the payroll before disbursement');
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(tx.businessLedgerEntry.create).not.toHaveBeenCalled();
        expect(tx.businessEmployee.update).not.toHaveBeenCalled();
    });

    test('blocks disbursement when EWA changes after processing', async () => {
        const tx = {
            payrollRecord: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'payroll-2',
                    businessProfileId: 'business-a',
                    employeeId: 'employee-1',
                    userId: 7,
                    period: '2026-08',
                    status: 'PENDING',
                    netAmount: 90,
                    totalHours: 8,
                    breakdown: { shifts: 1 },
                    ewaDeduction: 10,
                    employee: {
                        businessProfileId: 'business-a',
                        withdrawnEarly: 20,
                        smartRouteId: null,
                    },
                }),
                update: jest.fn(),
            },
            shift: {
                findMany: jest.fn().mockResolvedValue([
                    { actualMinutes: 480, breakMinutes: 0 },
                ]),
            },
            user: { update: jest.fn() },
            transactionHistory: { create: jest.fn() },
            businessLedgerEntry: { create: jest.fn() },
            businessEmployee: { update: jest.fn() },
        };
        const service = new PayrollService({ $transaction: makeTransaction(tx) });

        await expect(service.disbursePayroll('payroll-2', 'business-a'))
            .rejects.toThrow('earned-wage withdrawal changed after processing; reprocess the payroll before disbursement');
        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.transactionHistory.create).not.toHaveBeenCalled();
    });

    test('allows an unchanged payroll snapshot to proceed to payment', async () => {
        const processed = { id: 'payroll-3', status: 'PROCESSED' };
        const tx = {
            payrollRecord: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'payroll-3',
                    businessProfileId: 'business-a',
                    employeeId: 'employee-1',
                    userId: 7,
                    period: '2026-08',
                    status: 'PENDING',
                    netAmount: 100,
                    totalHours: 8,
                    breakdown: { shifts: 1 },
                    ewaDeduction: 0,
                    employee: {
                        businessProfileId: 'business-a',
                        withdrawnEarly: 0,
                        smartRouteId: null,
                    },
                }),
                update: jest.fn().mockResolvedValue(processed),
            },
            shift: {
                findMany: jest.fn().mockResolvedValue([
                    { actualMinutes: 480, breakMinutes: 0 },
                ]),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
            businessEmployee: { update: jest.fn().mockResolvedValue({}) },
        };
        const service = new PayrollService({ $transaction: makeTransaction(tx) });

        await expect(service.disbursePayroll('payroll-3', 'business-a')).resolves.toEqual(processed);
        expect(tx.user.update).toHaveBeenCalledTimes(1);
        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
        expect(tx.businessEmployee.update).toHaveBeenCalledTimes(1);
    });
});
