const { EwaService } = require('../services/businessOS/ewaService');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

describe('EwaService business scoping', () => {
    test('requestWithdrawal scopes the employee read to the supplied business', async () => {
        const prisma = {
            $transaction: jest.fn().mockImplementation(async (callback, options) => {
                expect(options).toEqual({ isolationLevel: 'Serializable' });
                return callback({
                    businessEmployee: {
                        findFirst: jest.fn().mockResolvedValue(null),
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
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce(employee)
                    .mockResolvedValueOnce({ ...employee, withdrawnEarly: 10 }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

        expect(tx.businessEmployee.findFirst).toHaveBeenNthCalledWith(1, {
            where: { id: 'employee-a', businessProfileId: 'business-a' },
        });
        expect(tx.businessEmployee.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ businessProfileId: 'business-a' }),
        }));
    });

    test('requestWithdrawal rejects a cross-business explicit scope against request context', async () => {
        const service = new EwaService({});

        await runWithBusinessRequestContext({ businessProfileId: 'business-a', userId: 101 }, async () => {
            await expect(service.requestWithdrawal({
                employeeId: 'employee-a',
                businessProfileId: 'business-b',
                amount: 10,
            })).rejects.toThrow('Business scope mismatch.');
        });
    });

    test('requestWithdrawal allows a worker to withdraw for themselves but not for another employee', async () => {
        const employee = {
            id: 'employee-a',
            businessProfileId: 'business-a',
            userId: 101,
            status: 'ACTIVE',
            ewaEligible: true,
            accruedWages: 100,
            withdrawnEarly: 0,
        };
        const otherEmployee = { ...employee, id: 'employee-b', userId: 202 };
        const tx = {
            businessEmployee: {
                findFirst: jest
                    .fn()
                    .mockResolvedValueOnce(employee)
                    .mockResolvedValueOnce({ ...employee, withdrawnEarly: 10 }),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            user: { update: jest.fn().mockResolvedValue({}) },
            transactionHistory: { create: jest.fn().mockResolvedValue({}) },
            businessLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
        };
        const prisma = {
            $transaction: jest.fn().mockImplementation(async (callback) => callback(tx)),
        };
        const service = new EwaService(prisma);

        await runWithBusinessRequestContext({ businessProfileId: 'business-a', userId: 101 }, async () => {
            await expect(service.requestWithdrawal({
                employeeId: 'employee-a',
                amount: 10,
            })).resolves.toMatchObject({ success: true });
        });

        tx.businessEmployee.findFirst.mockReset();
        tx.businessEmployee.findFirst.mockResolvedValueOnce(otherEmployee).mockResolvedValueOnce({
            id: 'employee-2',
            businessProfileId: 'business-a',
            userId: 303,
            permissions: ['ewa.manage'],
        });

        await runWithBusinessRequestContext({ businessProfileId: 'business-a', userId: 101 }, async () => {
            await expect(service.requestWithdrawal({
                employeeId: 'employee-b',
                amount: 10,
            })).rejects.toThrow('permission to manage EWA');
        });
    });
});
