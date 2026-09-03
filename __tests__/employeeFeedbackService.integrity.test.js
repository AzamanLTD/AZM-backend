const { EmployeeFeedbackService } = require('../services/businessOS/employeeFeedbackService');

describe('EmployeeFeedbackService integrity', () => {
    test('recomputes rating only from the receiver business history inside one serializable transaction', async () => {
        const txEmployeeFeedback = {
            create: jest.fn().mockResolvedValue({ id: 'feedback-a' }),
            findMany: jest.fn().mockResolvedValue([{ rating: 5 }, { rating: 3 }]),
        };
        const txBusinessEmployee = {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        };
        const prisma = {
            businessEmployee: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ id: 'from-a', businessProfileId: 'bp-a', userId: 'user-a' })
                    .mockResolvedValueOnce({ id: 'to-a', businessProfileId: 'bp-a', userId: 'user-b' }),
            },
            $transaction: jest.fn(async (callback) => callback({
                employeeFeedback: txEmployeeFeedback,
                businessEmployee: txBusinessEmployee,
            })),
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
        expect(txEmployeeFeedback.findMany).toHaveBeenCalledWith({
            where: { businessProfileId: 'bp-a', receiverEmployeeId: 'to-a' },
            select: { rating: true },
        });
        expect(txBusinessEmployee.updateMany).toHaveBeenCalledWith({
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
});
