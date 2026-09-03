const { PayrollService } = require('../services/businessOS/payrollService');
const { runWithRequestContext } = require('../utils/requestContext');

describe('PayrollService Serializable retry', () => {
    test('retries a transient P2034 disbursement conflict and succeeds', async () => {
        const payroll = {
            id: 'payroll-1', businessProfileId: 'business-a', employeeId: 'employee-1', userId: 101,
            status: 'PENDING', netAmount: 100,
            employee: { businessProfileId: 'business-a', smartRouteId: null }, period: '2026-09',
        };
        const tx = {
            payrollRecord: {
                findFirst: jest.fn().mockResolvedValue(payroll),
                update: jest.fn().mockResolvedValue({ ...payroll, status: 'PROCESSED' }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
            businessEmployee: { update: jest.fn().mockResolvedValue({}) },
        };
        const conflict = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
        const prisma = {
            $transaction: jest.fn()
                .mockRejectedValueOnce(conflict)
                .mockImplementationOnce(async (callback, options) => {
                    expect(options).toEqual({ isolationLevel: 'Serializable' });
                    return callback(tx);
                }),
        };
        const service = new PayrollService(prisma);

        await runWithRequestContext({ businessProfileId: 'business-a', user: { id: 999 } }, async () => {
            await expect(service.disbursePayroll('payroll-1')).resolves.toMatchObject({ status: 'PROCESSED' });
        });

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(tx.user.update).toHaveBeenCalledTimes(1);
        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
        expect(tx.businessEmployee.update).toHaveBeenCalledTimes(1);
        expect(tx.payrollRecord.update).toHaveBeenCalledTimes(1);
    });

    test('does not retry non-serialization failures', async () => {
        const error = new Error('payment unavailable');
        const prisma = { $transaction: jest.fn().mockRejectedValue(error) };
        const service = new PayrollService(prisma);

        await runWithRequestContext({ businessProfileId: 'business-a', user: { id: 999 } }, async () => {
            await expect(service.disbursePayroll('payroll-1')).rejects.toBe(error);
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test('stops after three serialization attempts', async () => {
        const conflict = Object.assign(new Error('serialization conflict'), { code: 'P2034' });
        const prisma = { $transaction: jest.fn().mockRejectedValue(conflict) };
        const service = new PayrollService(prisma);

        await runWithRequestContext({ businessProfileId: 'business-a', user: { id: 999 } }, async () => {
            await expect(service.disbursePayroll('payroll-1')).rejects.toBe(conflict);
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });
});
