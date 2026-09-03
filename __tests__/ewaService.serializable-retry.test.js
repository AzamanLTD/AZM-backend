const { EwaService } = require('../services/businessOS/ewaService');

describe('EwaService Serializable retry', () => {
    const employee = {
        id: 'employee-1',
        businessProfileId: 'business-a',
        userId: 101,
        status: 'ACTIVE',
        ewaEligible: true,
        accruedWages: 100,
        withdrawnEarly: 0,
    };

    function transactionClient() {
        return {
            businessEmployee: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(employee)
                    .mockResolvedValueOnce({ ...employee, withdrawnEarly: 9.09 }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
        };
    }

    test('retries a transient P2034 withdrawal conflict and succeeds', async () => {
        const tx = transactionClient();
        const conflict = Object.assign(
            new Error('Transaction failed due to a write conflict or a deadlock.'),
            { code: 'P2034' },
        );
        const prisma = {
            $transaction: jest.fn()
                .mockRejectedValueOnce(conflict)
                .mockImplementationOnce(async (callback, options) => {
                    expect(options).toEqual({ isolationLevel: 'Serializable' });
                    return callback(tx);
                }),
        };
        const service = new EwaService(prisma);

        await expect(service.requestWithdrawal({
            employeeId: 'employee-1',
            amount: 10,
            destination: 'AZM_BALANCE',
        })).resolves.toEqual(expect.objectContaining({
            success: true,
            grossAmount: 10,
            fee: 0.1,
            netToEmployee: 9.9,
        }));

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(tx.businessEmployee.updateMany).toHaveBeenCalledTimes(1);
        expect(tx.user.update).toHaveBeenCalledTimes(1);
        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
    });

    test('does not retry non-serialization failures', async () => {
        const error = new Error('balance service unavailable');
        const prisma = { $transaction: jest.fn().mockRejectedValue(error) };
        const service = new EwaService(prisma);

        await expect(service.requestWithdrawal({
            employeeId: 'employee-1',
            amount: 10,
        })).rejects.toBe(error);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test('stops after three serialization attempts', async () => {
        const conflict = Object.assign(new Error('serialization conflict'), { code: 'P2034' });
        const prisma = { $transaction: jest.fn().mockRejectedValue(conflict) };
        const service = new EwaService(prisma);

        await expect(service.requestWithdrawal({
            employeeId: 'employee-1',
            amount: 10,
        })).rejects.toBe(conflict);

        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });
});
