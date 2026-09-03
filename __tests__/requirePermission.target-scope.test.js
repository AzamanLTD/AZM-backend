const { requirePermission } = require('../middleware/requirePermission');

describe('requirePermission target business scoping', () => {
    function makeReq({ key, id = 'target', businessProfileId = 'business-a' }) {
        const prisma = {
            businessProfile: { findFirst: jest.fn().mockResolvedValue({ id: businessProfileId, userId: 99 }) },
            businessEmployee: { findUnique: jest.fn().mockResolvedValue({ permissions: ['*'], status: 'ACTIVE', role: 'MANAGER' }) },
            shift: { findFirst: jest.fn().mockResolvedValue({ id }) },
            shiftSwap: { findFirst: jest.fn().mockResolvedValue({ id }) },
        };
        return { req: { user: { id: 1, role: 'BUSINESS' }, params: { id }, businessProfileId, app: { get: jest.fn().mockReturnValue(prisma) } }, prisma, middleware: requirePermission(key) };
    }

    test.each([
        ['shifts.update', 'shift'],
        ['shifts.delete', 'shift'],
        ['shifts.approve_swap', 'shiftSwap'],
        ['employees.manage', 'businessEmployee'],
        ['employees.permissions', 'businessEmployee'],
    ])('checks %s target ownership before next()', async (key) => {
        const { req, prisma, middleware } = makeReq({ key });
        const next = jest.fn();
        const model = prisma[key === 'shifts.approve_swap' ? 'shiftSwap' : key.startsWith('shifts.') ? 'shift' : 'businessEmployee'];
        model.findFirst.mockResolvedValue(null);
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await middleware(req, res, next);
        expect(model.findFirst).toHaveBeenCalledWith({ where: { id: 'target', businessProfileId: 'business-a' }, select: { id: true } });
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('allows a same-business mutation target to reach the handler', async () => {
        const { req, prisma, middleware } = makeReq({ key: 'shifts.update' });
        const next = jest.fn();
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await middleware(req, res, next);
        expect(prisma.shift.findFirst).toHaveBeenCalledWith({ where: { id: 'target', businessProfileId: 'business-a' }, select: { id: true } });
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('does not add a target guard to unrelated permissions', async () => {
        const { req, prisma, middleware } = makeReq({ key: 'employees.create' });
        const next = jest.fn();
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await middleware(req, res, next);
        expect(prisma.shift.findFirst).not.toHaveBeenCalled();
        expect(prisma.shiftSwap.findFirst).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });
});
