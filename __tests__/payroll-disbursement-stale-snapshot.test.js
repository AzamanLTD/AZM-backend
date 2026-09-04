const { PayrollService } = require('../services/businessOS/payrollService');
const { runWithRequestContext } = require('../utils/requestContext');

describe('PayrollService disbursement snapshot consistency', () => {
    const makeTx = ({ shifts = [] } = {}) => ({
        payrollRecord: {
            findFirst: jest.fn(),
            update: jest.fn().mockResolvedValue({ status: 'PROCESSED' }),
        },
        shift: { findMany: jest.fn().mockResolvedValue(shifts) },
        user: { update: jest.fn().mockResolvedValue({}) },
        transactionHistory: { create: jest.fn().mockResolvedValue({}) },
        businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
        businessEmployee: { update: jest.fn().mockResolvedValue({}) },
    });

    const basePayroll = (overrides = {}) => ({
        id: 'payroll-1',
        businessProfileId: 'business-a',
        employeeId: 'employee-1',
        userId: 101,
        status: 'PENDING',
        payrollType: 'HOURLY',
        period: '2026-09',
        baseAmount: 80,
        overtimeAmount: 0,
        grossAmount: 80,
        ewaDeduction: 0,
        netAmount: 80,
        totalHours: 8,
        overtimeHours: 0,
        breakdown: { shifts: 1, regularHours: 8, overtimeHours: 0, ewaWithdrawn: 0 },
        employee: {
            businessProfileId: 'business-a',
            payrollType: 'HOURLY',
            hourlyRate: 10,
            salaryAmount: null,
            withdrawnEarly: 0,
            smartRouteId: null,
        },
        ...overrides,
    });

    test('rejects a pending record when a later clock-out changes the period inputs', async () => {
        const payroll = basePayroll();
        const tx = makeTx({ shifts: [
            { actualMinutes: 480, breakMinutes: 0 },
            { actualMinutes: 240, breakMinutes: 0 },
        ] });
        tx.payrollRecord.findFirst.mockResolvedValue(payroll);
        const prisma = {
            $transaction: jest.fn(async (callback) => callback(tx)),
        };
        const service = new PayrollService(prisma);

        await runWithRequestContext({ businessProfileId: 'business-a', user: { id: 999 } }, async () => {
            await expect(service.disbursePayroll('payroll-1')).rejects.toThrow(
                'Payroll for period 2026-09 is stale; regenerate it before disbursement.',
            );
        });

        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(tx.businessLedgerEntry.create).not.toHaveBeenCalled();
        expect(tx.businessEmployee.update).not.toHaveBeenCalled();
        expect(tx.payrollRecord.update).not.toHaveBeenCalled();
    });

    test('allows an unchanged payroll record to disburse normally', async () => {
        const payroll = basePayroll();
        const tx = makeTx({ shifts: [{ actualMinutes: 480, breakMinutes: 0 }] });
        tx.payrollRecord.findFirst.mockResolvedValue(payroll);
        const prisma = {
            $transaction: jest.fn(async (callback, options) => {
                expect(options).toEqual({ isolationLevel: 'Serializable' });
                return callback(tx);
            }),
        };
        const service = new PayrollService(prisma);

        await runWithRequestContext({ businessProfileId: 'business-a', user: { id: 999 } }, async () => {
            await expect(service.disbursePayroll('payroll-1')).resolves.toMatchObject({ status: 'PROCESSED' });
        });

        expect(tx.user.update).toHaveBeenCalledTimes(1);
        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
        expect(tx.businessEmployee.update).toHaveBeenCalledTimes(1);
        expect(tx.payrollRecord.update).toHaveBeenCalledTimes(1);
    });

    test('rejects an EWA change even when shift hours are unchanged', async () => {
        const payroll = basePayroll();
        const tx = makeTx({ shifts: [{ actualMinutes: 480, breakMinutes: 0 }] });
        tx.payrollRecord.findFirst.mockResolvedValue({
            ...payroll,
            employee: { ...payroll.employee, withdrawnEarly: 20 },
        });
        const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
        const service = new PayrollService(prisma);

        await runWithRequestContext({ businessProfileId: 'business-a', user: { id: 999 } }, async () => {
            await expect(service.disbursePayroll('payroll-1')).rejects.toThrow('Payroll for period 2026-09 is stale');
        });
        expect(tx.user.update).not.toHaveBeenCalled();
    });
});
