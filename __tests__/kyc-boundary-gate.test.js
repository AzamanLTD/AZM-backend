// __tests__/kyc-boundary-gate.test.js
// =============================================================================
// The financial-action identity gate.
//
// Before middleware/requireKyc.js, no financial route read User.kycStatus, so
// verification was decorative. These tests pin the behaviour that makes it
// real: an unverified user is REFUSED at the withdrawal boundary, a verified
// user passes untouched, and the scope switch means trading/susu/p2p keep their
// current behaviour until the owner widens it.
// =============================================================================

const { requireKyc, gatedActions, DEFAULT_GATED_ACTIONS } = require('../middleware/requireKyc');

function makeRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

function makeReq({ id = 'user_1', kycStatus = 'UNVERIFIED', role = 'USER', isDeleted = false } = {}) {
    const prisma = {
        user: {
            findUnique: jest.fn(async () => ({ kycStatus, role, isDeleted })),
        },
    };
    return {
        user: { id },
        app: { get: () => prisma },
        _prisma: prisma,
    };
}

describe('requireKyc — scope', () => {
    const ORIGINAL = process.env.KYC_GATED_ACTIONS;
    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.KYC_GATED_ACTIONS;
        else process.env.KYC_GATED_ACTIONS = ORIGINAL;
    });

    test('defaults to the required money-moving baseline', () => {
        // The old default gated withdrawals only, which left deposit, P2P,
        // trade and susu starts open — narrower than the product requirement.
        delete process.env.KYC_GATED_ACTIONS;
        expect(gatedActions().has('withdraw')).toBe(true);
        expect(gatedActions().has('deposit')).toBe(true);
        expect(gatedActions().has('p2p')).toBe(true);
        expect(gatedActions().has('trade')).toBe(true);
        expect(gatedActions().has('susu')).toBe(true);
        expect(DEFAULT_GATED_ACTIONS).toBe('withdraw,deposit,p2p,trade,susu');
    });

    test('scope is additive, case and space tolerant, never subtractive', () => {
        // A narrowed env may only ADD: the required baseline survives it.
        process.env.KYC_GATED_ACTIONS = ' Withdraw , SAVINGS ';
        const set = gatedActions();
        expect(set.has('withdraw')).toBe(true);
        expect(set.has('savings')).toBe(true);
        expect(set.has('deposit')).toBe(true);
        expect(set.has('p2p')).toBe(true);
        expect(set.has('trade')).toBe(true);
        expect(set.has('susu')).toBe(true);
    });

    test('an action outside the configured scope passes WITHOUT touching the database', async () => {
        delete process.env.KYC_GATED_ACTIONS;
        const req = makeReq();
        const res = makeRes();
        const next = jest.fn();

        // 'browse' is genuinely outside the money-moving matrix; trade is not.
        await requireKyc('browse')(req, res, next);

        expect(next).toHaveBeenCalledWith();
        expect(req._prisma.user.findUnique).not.toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('widening the env scope gates the newly named action', async () => {
        process.env.KYC_GATED_ACTIONS = 'withdraw,trade';
        const req = makeReq({ kycStatus: 'UNVERIFIED' });
        const res = makeRes();
        const next = jest.fn();

        await requireKyc('trade')(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});

describe('requireKyc — verdicts', () => {
    beforeEach(() => { delete process.env.KYC_GATED_ACTIONS; });

    test('VERIFIED passes straight through', async () => {
        const req = makeReq({ kycStatus: 'VERIFIED' });
        const res = makeRes();
        const next = jest.fn();

        await requireKyc('withdraw')(req, res, next);

        expect(next).toHaveBeenCalledWith();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('UNVERIFIED is refused with KYC_REQUIRED and the action named', async () => {
        const req = makeReq({ kycStatus: 'UNVERIFIED' });
        const res = makeRes();
        const next = jest.fn();

        await requireKyc('withdraw')(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.code).toBe('KYC_REQUIRED');
        expect(body.kycStatus).toBe('UNVERIFIED');
        expect(body.requiredFor).toBe('withdraw');
        expect(body.message).toMatch(/verify your identity/i);
    });

    test('PENDING is refused as under review, never as "not started"', async () => {
        const res = makeRes();
        await requireKyc('withdraw')(makeReq({ kycStatus: 'PENDING' }), res, jest.fn());

        const body = res.json.mock.calls[0][0];
        expect(body.code).toBe('KYC_PENDING');
        expect(body.message).toMatch(/under review/i);
        expect(body.kycStatus).toBe('PENDING');
    });

    test('REJECTED asks for a resubmission', async () => {
        const res = makeRes();
        await requireKyc('withdraw')(makeReq({ kycStatus: 'REJECTED' }), res, jest.fn());

        const body = res.json.mock.calls[0][0];
        expect(body.code).toBe('KYC_REJECTED');
        expect(body.message).toMatch(/resubmit/i);
    });

    test('a missing kycStatus is treated as unverified, not as a pass', async () => {
        const res = makeRes();
        await requireKyc('withdraw')(makeReq({ kycStatus: null }), res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('admins are not blocked (support and refund paths)', async () => {
        const res = makeRes();
        const next = jest.fn();
        await requireKyc('withdraw')(makeReq({ kycStatus: 'UNVERIFIED', role: 'ADMIN' }), res, next);
        expect(next).toHaveBeenCalledWith();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('unauthenticated requests are refused before any lookup', async () => {
        const res = makeRes();
        const req = makeReq();
        delete req.user;

        await requireKyc('withdraw')(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(401);
        expect(req._prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('a deleted user is refused', async () => {
        const res = makeRes();
        await requireKyc('withdraw')(makeReq({ isDeleted: true, kycStatus: 'VERIFIED' }), res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json.mock.calls[0][0].code).toBe('USER_GONE');
    });

    test('FAILS CLOSED: a database error is a 503, never a pass', async () => {
        const req = makeReq();
        req._prisma.user.findUnique.mockImplementationOnce(async () => {
            throw new Error('db down');
        });
        const res = makeRes();
        const next = jest.fn();

        await requireKyc('withdraw')(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
    });
});

describe('withdrawal routes carry the gate in the right place', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'routes', 'withdrawalRoutes.js'),
        'utf8',
    );

    test.each(['/fiat', '/crypto'])('%s is protect → requireKyc → require2FA → idempotency', (route) => {
        const start = src.indexOf(`router.post('${route}'`);
        expect(start).toBeGreaterThan(-1);
        const block = src.slice(start, src.indexOf('withdrawalController', start));
        const order = ['protect', "requireKyc('withdraw')", 'require2FA()', 'idempotency(']
            .map((needle) => block.indexOf(needle));
        // Every clause present, and each one after the previous.
        expect(order.every((i) => i > -1)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    test('the gate is NOT on the read-only status route', () => {
        const line = src.split('\n').find((l) => l.includes("'/status/:reference'"));
        expect(line).toBeDefined();
        expect(line).not.toContain('requireKyc');
    });
});
