const { PayrollService } = require('../services/businessOS/payrollService');

describe('PayrollService disbursement integrity', () => {
    function buildPrisma({ netAmount = 110, smartRouteId = null, failureAt = null } = {}) {
        const payroll = {
            id: 'payroll-a', businessProfileId: 'business-a', employeeId: 'employee-a', userId: 'user-a', period: '2026-09', status: 'PENDING',
            payrollType: 'HOURLY', baseAmount: 100, overtimeAmount: 10, grossAmount: 110,
            ewaDeduction: 0, totalHours: 10, overtimeHours: 2, netAmount,
            breakdown: { shifts: 1, regularHours: 8, overtimeHours: 2, ewaWithdrawn: 0 },
            employee: {
                id: 'employee-a', businessProfileId: 'business-a', userId: 'user-a', smartRouteId,
                payrollType: 'HOURLY', hourlyRate: 10, salaryAmount: null, withdrawnEarly: 0,
            },
        };
        const tx = {
            payrollRecord: {
                findFirst: jest.fn().mockResolvedValue(payroll),
                update: jest.fn().mockResolvedValue({ ...payroll, status: 'PROCESSED' }),
            },
            shift: {
                findMany: jest.fn().mockResolvedValue([{ actualMinutes: 600, breakMinutes: 0 }]),
            },
            user: { update: jest.fn().mockImplementation(async () => { if (failureAt === 'user') throw new Error('balance write failed'); return { id: 'user-a' }; }) },
            transactionHistory: { create: jest.fn().mockImplementation(async () => { if (failureAt === 'history') throw new Error('history write failed'); return { id: 'history-a' }; }) },
            businessLedgerEntry: { create: jest.fn().mockImplementation(async () => { if (failureAt === 'ledger') throw new Error('ledger write failed'); return { id: 'ledger-a' }; }) },
            businessEmployee: { update: jest.fn().mockImplementation(async () => { if (failureAt === 'employee') throw new Error('employee reset failed'); return { id: 'employee-a' }; }) },
        };
        return {
            tx,
            $transaction: jest.fn(async (callback, options) => { expect(options).toEqual({ isolationLevel: 'Serializable' }); return callback(tx); }),
        };
    }

    test('settles direct payroll and all accounting state in one serializable transaction', async () => {
        const prisma = buildPrisma();
        const svc = new PayrollService(prisma);
        const result = await svc.disbursePayroll('payroll-a', 'business-a');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-a' }, data: { azmBalance: { increment: 110 } } });
        expect(prisma.tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessEmployee.update).toHaveBeenCalledWith({ where: { id: 'employee-a' }, data: { accruedWages: 0.0, withdrawnEarly: 0.0 } });
        expect(prisma.tx.payrollRecord.update).toHaveBeenCalledWith({ where: { id: 'payroll-a' }, data: { status: 'PROCESSED', paidAt: expect.any(Date), failureReason: null } });
        expect(result.status).toBe('PROCESSED');
    });

    test('leaves payroll pending on settlement failure instead of recording a false paid state', async () => {
        const prisma = buildPrisma({ failureAt: 'ledger' });
        const svc = new PayrollService(prisma);
        await expect(svc.disbursePayroll('payroll-a', 'business-a')).rejects.toThrow('ledger write failed');
        expect(prisma.tx.payrollRecord.update).not.toHaveBeenCalled();
        expect(prisma.tx.businessEmployee.update).not.toHaveBeenCalled();
    });

    test('refuses to mark Smart Route payroll paid without an exact settlement worker', async () => {
        const prisma = buildPrisma({ smartRouteId: 'route-a' });
        const svc = new PayrollService(prisma);
        await expect(svc.disbursePayroll('payroll-a', 'business-a')).rejects.toThrow('Payroll with Smart Route requires the payroll settlement worker; it was not marked as paid.');
        expect(prisma.tx.user.update).not.toHaveBeenCalled();
        expect(prisma.tx.payrollRecord.update).not.toHaveBeenCalled();
    });
});
