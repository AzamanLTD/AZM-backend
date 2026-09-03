const { EwaService } = require('../services/businessOS/ewaService');

describe('EwaService integrity', () => {
    const employee = {
        id: 'employee-a',
        userId: 'user-a',
        businessProfileId: 'business-a',
        ewaEligible: true,
        status: 'ACTIVE',
        accruedWages: 100,
        withdrawnEarly: 10,
    };

    function buildPrisma({ transactionError = null } = {}) {
        const tx = {
            businessEmployee: {
                findUnique: jest.fn().mockResolvedValue(employee),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            user: {
                update: jest.fn().mockResolvedValue({ id: 'user-a', azmBalance: 119.8 }),
            },
            transactionHistory: {
                create: jest.fn().mockResolvedValue({ id: 'history-a' }),
            },
            businessLedgerEntry: {
                create: jest.fn().mockResolvedValue({ id: 'ledger-a' }),
            },
        };

        return {
            businessEmployee: {
                findUnique: jest.fn().mockResolvedValue(employee),
            },
            $transaction: jest.fn(async (callback, options) => {
                expect(options).toEqual({ isolationLevel: 'Serializable' });
                if (transactionError) throw transactionError;
                return callback(tx);
            }),
            tx,
        };
    }

    test('claims EWA capacity and all money/ledger writes through the same transaction', async () => {
        const prisma = buildPrisma();
        const svc = new EwaService(prisma);

        await expect(svc.requestWithdrawal({
            employeeId: 'employee-a',
            amount: 20,
        })).resolves.toMatchObject({
            success: true,
            grossAmount: 20,
            fee: 0.2,
            netToEmployee: 19.8,
            remainingWithdrawable: 0,
        });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessEmployee.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'employee-a',
                status: 'ACTIVE',
                ewaEligible: true,
                withdrawnEarly: { lte: 10 },
            },
            data: { withdrawnEarly: { increment: 20 } },
        });
        expect(prisma.tx.user.update).toHaveBeenCalledWith({
            where: { id: 'user-a' },
            data: { azmBalance: { increment: 19.8 } },
        });
        expect(prisma.tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessLedgerEntry.create).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid and over-limit amounts without performing a settlement write', async () => {
        const prisma = buildPrisma();
        const svc = new EwaService(prisma);

        await expect(svc.requestWithdrawal({ employeeId: 'employee-a', amount: Number.NaN }))
            .rejects.toThrow('Amount must be a valid number.');
        await expect(svc.requestWithdrawal({ employeeId: 'employee-a', amount: 0 }))
            .rejects.toThrow('Minimum withdrawal is 1 AZM.');
        await expect(svc.requestWithdrawal({ employeeId: 'employee-a', amount: 21 }))
            .rejects.toThrow('Amount exceeds available EWA balance. Max: 20.00 AZM');

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessEmployee.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.user.update).not.toHaveBeenCalled();
        expect(prisma.tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(prisma.tx.businessLedgerEntry.create).not.toHaveBeenCalled();
    });

    test('does not perform a detached withdrawnEarly claim when the settlement transaction fails', async () => {
        const transactionError = new Error('ledger unavailable');
        const prisma = buildPrisma({ transactionError });
        const svc = new EwaService(prisma);

        await expect(svc.requestWithdrawal({
            employeeId: 'employee-a',
            amount: 20,
        })).rejects.toThrow('ledger unavailable');

        expect(prisma.tx.businessEmployee.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.user.update).not.toHaveBeenCalled();
        expect(prisma.tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(prisma.tx.businessLedgerEntry.create).not.toHaveBeenCalled();
    });
});
