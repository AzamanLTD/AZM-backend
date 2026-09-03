const { EwaService } = require('../services/businessOS/ewaService');

describe('EwaService business scoping', () => {
    test('requestWithdrawal scopes the employee read to the supplied business', async () => {
        const prisma = {
            $transaction: jest.fn().mockImplementation(async (callback, options) => {
                expect(options).toEqual({ isolationLevel: 'Serializable' });
                return callback({
                    businessEmployee: {
                        findUnique: jest.fn().mockResolvedValue(null),
                    },
                });
            }),
        };
        const service = new EwaService(prisma);

        await expect(service.requestWithdrawal({
            employeeId: 'employee-a',
            businessProfileId: 'business-b',
            amount: 10,
        })).rejects.toThrow('Employee not found.');
    });

    test('requestWithdrawal accepts the employee only when it belongs to the supplied business', async () => {
        const employee = {
            id: 'employee-a',
            businessProfileId: 'business-a',
            userId: 101,
            status: 'ACTIVE',
            ewaEligible: true,
            accruedWages: 100,
            withdrawnEarly: 0,
        };
        const tx = {
            businessEmployee: {
                findUnique: jest.fn().mockResolvedValue(employee),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue({ ...employee, withdrawnEarly: 10 }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            $transaction: jest.fn().mockImplementation(async (callback, options) => {
                expect(options).toEqual({ isolationLevel: 'Serializable' });
                return callback(tx);
            }),
        };
        const service = new EwaService(prisma);

        await expect(service.requestWithdrawal({
            employeeId: 'employee-a',
            businessProfileId: 'business-a',
            amount: 10,
        })).resolves.toMatchObject({
            success: true,
            grossAmount: 10,
            netToEmployee: 9.9,
        });

        expect(tx.businessEmployee.findUnique).toHaveBeenNthCalledWith(1, {
            where: { id: 'employee-a', businessProfileId: 'business-a' },
        });
        expect(tx.businessEmployee.updateMany).toHaveBeenCalled();
    });
});
