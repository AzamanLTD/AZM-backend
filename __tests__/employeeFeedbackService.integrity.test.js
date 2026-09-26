const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');

describe('EmployeeFeedbackService integrity', () => {
    const transactionClient = () => ({
        employeeFeedback: {
            create: jest.fn().mockResolvedValue({ id: 'feedback-a' }),
            findMany: jest.fn().mockResolvedValue([{ rating: 5 }, { rating: 3 }]),
        },
        businessEmployee: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    });

    test('recomputes rating only from the receiver business history inside one serializable transaction', async () => {
        const tx = transactionClient();
        const prisma = {
            businessEmployee: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ id: 'from-a', businessProfileId: 'bp-a', userId: 'user-a' })
                    .mockResolvedValueOnce({ id: 'to-a', businessProfileId: 'bp-a', userId: 'user-b' }),
            },
            $transaction: jest.fn(async (callback) => callback(tx)),
        };
        const svc = new EmployeeFeedbackService(prisma);

        await expect(svc.createFeedback({
            businessProfileId: 'bp-a',
            fromEmployeeId: 'from-a',
            toEmployeeId: 'to-a',
            rating: 3,
        })).resolves.toEqual({ id: 'feedback-a' });

        expect(prisma.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
        expect(tx.employeeFeedback.findMany).toHaveBeenCalledWith({
            where: { businessProfileId: 'bp-a', receiverEmployeeId: 'to-a' },
            select: { rating: true },
        });
        expect(tx.businessEmployee.updateMany).toHaveBeenCalledWith({
            where: { id: 'to-a', businessProfileId: 'bp-a' },
            data: { rating: 4, ratingCount: 2 },
        });
    });

    test('rejects cross-business receiver before creating feedback', async () => {
        const prisma = {
            businessEmployee: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ id: 'from-a', businessProfileId: 'bp-a', userId: 'user-a' })
                    .mockResolvedValueOnce({ id: 'to-b', businessProfileId: 'bp-b', userId: 'user-b' }),
            },
            $transaction: jest.fn(),
        };
        const svc = new EmployeeFeedbackService(prisma);

        await expect(svc.createFeedback({
            businessProfileId: 'bp-a',
            fromEmployeeId: 'from-a',
            toEmployeeId: 'to-b',
            rating: 5,
        })).rejects.toThrow('Both employees must belong to the same business.');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    test('retries transient serializable conflicts and preserves the transaction boundary', async () => {
        const tx = transactionClient();
        const serializationConflict = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), {
            code: 'P2034',
        });
        const prisma = {
            businessEmployee: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ id: 'from-a', businessProfileId: 'bp-a', userId: 'user-a' })
                    .mockResolvedValueOnce({ id: 'to-a', businessProfileId: 'bp-a', userId: 'user-b' }),
            },
            $transaction: jest.fn()
                .mockRejectedValueOnce(serializationConflict)
                .mockImplementationOnce(async (callback, options) => {
                    expect(options).toEqual({ isolationLevel: 'Serializable' });
                    return callback(tx);
                }),
        };
        const svc = new EmployeeFeedbackService(prisma);

        await expect(svc.createFeedback({
            businessProfileId: 'bp-a',
            fromEmployeeId: 'from-a',
            toEmployeeId: 'to-a',
            rating: 5,
        })).resolves.toEqual({ id: 'feedback-a' });

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable' });
        expect(prisma.$transaction.mock.calls[1][1]).toEqual({ isolationLevel: 'Serializable' });
    });
});