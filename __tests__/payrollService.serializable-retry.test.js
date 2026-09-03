const { PayrollService } = require('../services/businessOS/payrollService');

describe('PayrollService serializable retry', () => {
    test('retries transient P2034 conflicts and returns the committed payroll result', async () => {
        const payroll = {
            id: 'payroll-1',
            businessProfileId: 'business-1',
            employeeId: 'employee-1',
            userId: 42,
            status: 'PENDING',
            netAmount: 100,
            businessProfileId: 'business-1',
            employee: {
                businessProfileId: 'business-1',
                smartRouteId: null,
            },
        };
        const updated = { ...payroll, status: 'PROCESSED' };
        let transactionAttempts = 0;
        const tx = {
            payrollRecord: {
                findFirst: jest.fn().mockResolvedValue(payroll),
                update: jest.fn().mockResolvedValue(updated),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
            businessEmployee: { update: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            $transaction: jest.fn().mockImplementation(async (callback) => {
                transactionAttempts += 1;
                if (transactionAttempts === 1) {
                    const error = new Error('serialization conflict');
                    error.code = 'P2034';
                    throw error;
                }
                return callback(tx);
            }),
        };
        const service = new PayrollService(prisma);

        await expect(service.disbursePayroll('payroll-1', 'business-1')).resolves.toEqual(updated);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(tx.user.update).toHaveBeenCalledTimes(1);
        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
        expect(tx.businessEmployee.update).toHaveBeenCalledTimes(1);
        expect(tx.payrollRecord.update).toHaveBeenCalledTimes(1);
    });

    test('does not retry non-serialization failures', async () => {
        const prisma = {
            $transaction: jest.fn().mockRejectedValue(Object.assign(new Error('database unavailable'), { code: 'P2002' })),
        };
        const service = new PayrollService(prisma);

        await expect(service.disbursePayroll('payroll-1', 'business-1')).rejects.toThrow('database unavailable');
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
});
