const { requirePermission } = require('../middleware/requirePermission');
const { getBusinessRequestContext } = require('../src/lib/businessRequestContext');

function invoke(middleware, req) {
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
    };
    return new Promise((resolve) => {
        middleware(req, res, () => resolve({ res, context: getBusinessRequestContext() }));
    });
}

describe('requirePermission business request context', () => {
    test('marks an owning business user as the business owner in downstream context', async () => {
        const prisma = {
            businessProfile: {
                findFirst: jest.fn().mockResolvedValue({ id: 'business-a', userId: 101 }),
            },
        };
        const req = {
            user: { id: 101, role: 'USER' },
            app: { get: jest.fn().mockReturnValue(prisma) },
        };

        const { context, res } = await invoke(requirePermission('shifts.update'), req);

        expect(res.status).not.toHaveBeenCalled();
        expect(context).toMatchObject({
            businessProfileId: 'business-a',
            isBusinessOwner: true,
            isAdmin: false,
        });
    });

    test('does not treat an employee wildcard permission as business ownership', async () => {
        const prisma = {
            businessProfile: {
                findFirst: jest.fn().mockResolvedValue({ id: 'business-a', userId: 202 }),
            },
            businessEmployee: {
                findUnique: jest.fn().mockResolvedValue({
                    permissions: ['*'],
                    status: 'ACTIVE',
                    role: 'GENERAL_MANAGER',
                }),
            },
        };
        const req = {
            user: { id: 101, role: 'USER' },
            app: { get: jest.fn().mockReturnValue(prisma) },
        };

        const { context, res } = await invoke(requirePermission('shifts.update'), req);

        expect(res.status).not.toHaveBeenCalled();
        expect(context).toMatchObject({
            businessProfileId: 'business-a',
            isBusinessOwner: false,
            isAdmin: false,
        });
    });
});
