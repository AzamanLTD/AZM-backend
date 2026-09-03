const { kybGate } = require('../middleware/kybGateMiddleware');

describe('kybGate security boundary', () => {
    const makeResponse = () => ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    });

    test('fails closed with 503 when the Prisma client is unavailable', async () => {
        const req = { user: { id: 7 }, app: { get: jest.fn().mockReturnValue(undefined) } };
        const res = makeResponse();
        const next = jest.fn();

        await kybGate(req, res, next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'KYB_GATE_UNAVAILABLE' }));
        expect(next).not.toHaveBeenCalled();
    });

    test('fails closed with 503 when the business verification lookup errors', async () => {
        const req = {
            user: { id: 7 },
            app: {
                get: jest.fn().mockReturnValue({
                    businessProfile: {
                        findFirst: jest.fn().mockRejectedValue(new Error('database unavailable')),
                    },
                }),
            },
        };
        const res = makeResponse();
        const next = jest.fn();

        await kybGate(req, res, next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'KYB_GATE_UNAVAILABLE' }));
        expect(next).not.toHaveBeenCalled();
    });

    test('continues only after a verified business is positively established', async () => {
        const req = {
            user: { id: 7 },
            app: {
                get: jest.fn().mockReturnValue({
                    businessProfile: {
                        findFirst: jest.fn().mockResolvedValue({ id: 'biz-1', kybStatus: 'VERIFIED', isSuspended: false }),
                    },
                }),
            },
        };
        const res = makeResponse();
        const next = jest.fn();

        await kybGate(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.businessProfile).toEqual({ id: 'biz-1', kybStatus: 'VERIFIED', isSuspended: false });
        expect(res.status).not.toHaveBeenCalled();
    });
});
