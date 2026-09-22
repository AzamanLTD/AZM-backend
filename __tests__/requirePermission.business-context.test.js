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
        // r26: a non-owner user (101) resolves the business context through
        // their OWN active employment (businessEmployee.findFirst), while the
        // business itself is owned by 202. Holding the wildcard permission
        // grants every permission KEY but never business ownership.
        const prisma = {
            businessProfile: {
                findFirst: jest.fn().mockImplementation(({ where }) => {
                    if (where.userId) return Promise.resolve(null); // user 101 owns nothing
                    return Promise.resolve({ id: 'business-a', userId: 202 });
                }),
            },
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue({
                    businessProfileId: 'business-a',
                    businessProfile: { id: 'business-a' },
                }),
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
