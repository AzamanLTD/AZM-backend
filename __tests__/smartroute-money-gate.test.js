// __tests__/smartroute-money-gate.test.js
// =============================================================================
// Smart Routes that move money away from the user carry the same identity and
// second-factor gates as the manual routes they automate.
//
//   1. create / update / resume / run-now of a WITHDRAW_MOMO or
//      INTERNAL_TRANSFER route require VERIFIED KYC and then require2FA.
//   2. Same-user routes (SAVINGS_DEPOSIT, VAULT_DEPOSIT) keep the session gate.
//   3. Pause / cancel / list / detail are not gated (they reduce or read).
//   4. Another user's route id answers 404 before any gate runs.
//   5. At execution, the withdrawal reservation and the internal transfer
//      re-check VERIFIED KYC inside the transaction (ADMIN exempt), with the
//      existing SMART_ROUTE_AUTHORIZATION_LOST token.
//   6. Amounts are exact, positive and at most 8 decimal places.
// =============================================================================
'use strict';

const { Prisma } = require('@prisma/client');
const routes = require('../routes/smartRouteRoutes');
const { smartRouteMoneyGate } = routes;

function mockRes() {
    return {
        _status: null, _body: null,
        status(c) { this._status = c; return this; },
        json(b) { this._body = b; return this; },
    };
}

function reqFor({ body = {}, params = {}, route = null, user = { kycStatus: 'VERIFIED', role: 'USER', twoFa: false } } = {}) {
    const prisma = {
        smartRoute: { findUnique: jest.fn(async () => route) },
        user: {
            findUnique: jest.fn(async ({ select }) => {
                if (select && 'kycStatus' in select) return { kycStatus: user.kycStatus, role: user.role, isDeleted: false };
                return { password: 'hash', isTwoFactorEnabled: user.twoFa, twoFactorSecret: null };
            }),
        },
    };
    return { body, params, user: { id: 5 }, app: { get: (k) => (k === 'prisma' ? prisma : null) }, prisma };
}

async function runGate(req) {
    const res = mockRes();
    let passed = false;
    await smartRouteMoneyGate(req, res, () => { passed = true; });
    return { res, passed };
}

describe('route wiring', () => {
    const layer = (method, path) => routes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    const hasGate = (l) => l.route.stack.some((s) => s.handle === smartRouteMoneyGate);

    test.each([
        ['post', '/'], ['patch', '/:id'], ['post', '/:id/resume'], ['post', '/:id/run-now'],
    ])('%s %s carries the money gate', (m, p) => {
        expect(hasGate(layer(m, p))).toBe(true);
    });

    test.each([
        ['post', '/:id/pause'], ['delete', '/:id'], ['get', '/'], ['get', '/:id'],
    ])('%s %s does not', (m, p) => {
        expect(hasGate(layer(m, p))).toBe(false);
    });
});

describe('money gate decisions', () => {
    test('create WITHDRAW_MOMO without VERIFIED KYC is refused 403 before 2FA', async () => {
        const req = reqFor({ body: { action: 'WITHDRAW_MOMO' }, user: { kycStatus: 'UNVERIFIED', role: 'USER' } });
        const { res, passed } = await runGate(req);
        expect(passed).toBe(false);
        expect(res._status).toBe(403);
        expect(res._body).toMatchObject({ code: 'KYC_REQUIRED', requiredFor: 'withdraw' });
    });

    test('create WITHDRAW_MOMO with KYC but no second factor is refused by require2FA', async () => {
        const req = reqFor({ body: { action: 'WITHDRAW_MOMO' } });
        const { res, passed } = await runGate(req);
        expect(passed).toBe(false);
        expect(res._status).toBe(401);
    });

    test('run-now resolves the action from the stored route (INTERNAL_TRANSFER → p2p)', async () => {
        const req = reqFor({ params: { id: 'r1' }, route: { userId: 5, action: 'INTERNAL_TRANSFER' }, user: { kycStatus: 'PENDING', role: 'USER' } });
        const { res, passed } = await runGate(req);
        expect(passed).toBe(false);
        expect(res._body).toMatchObject({ code: 'KYC_PENDING', requiredFor: 'p2p' });
    });

    test.each(['SAVINGS_DEPOSIT', 'VAULT_DEPOSIT'])('same-user %s passes with the session alone', async (action) => {
        const req = reqFor({ body: { action }, user: { kycStatus: 'UNVERIFIED', role: 'USER' } });
        const { passed } = await runGate(req);
        expect(passed).toBe(true);
    });

    test("another user's route answers 404 and never reaches KYC", async () => {
        const req = reqFor({ params: { id: 'r1' }, route: { userId: 99, action: 'WITHDRAW_MOMO' } });
        const { res, passed } = await runGate(req);
        expect(passed).toBe(false);
        expect(res._status).toBe(404);
        expect(req.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('a failed route lookup refuses 503, nothing changed', async () => {
        const req = reqFor({ params: { id: 'r1' } });
        req.prisma.smartRoute.findUnique.mockRejectedValueOnce(new Error('db down'));
        const { res, passed } = await runGate(req);
        expect(passed).toBe(false);
        expect(res._status).toBe(503);
    });
});

describe('execution-time identity check', () => {
    const SmartRouteService = require('../services/smartRouteService');
    const Svc = SmartRouteService.SmartRouteService || SmartRouteService;
    const svc = Object.create(Svc.prototype);
    const txFor = (row) => ({ user: { findUnique: jest.fn(async () => row) } });

    test('money-out boundary refuses an unverified user with the authorization-lost token', async () => {
        const tx = txFor({ banStatus: 'ACTIVE', isDeleted: false, kycStatus: 'UNVERIFIED', role: 'USER' });
        await expect(svc._assertLiveUserAuthorizationTx(tx, 5, { atBoundary: 'withdrawal reservation', requireVerifiedKyc: true }))
            .rejects.toMatchObject({ code: 'SMART_ROUTE_AUTHORIZATION_LOST' });
    });

    test('verified users and admins pass; same-user boundaries do not require KYC', async () => {
        await expect(svc._assertLiveUserAuthorizationTx(
            txFor({ banStatus: 'ACTIVE', isDeleted: false, kycStatus: 'VERIFIED', role: 'USER' }), 5, { requireVerifiedKyc: true },
        )).resolves.toBeUndefined();
        await expect(svc._assertLiveUserAuthorizationTx(
            txFor({ banStatus: 'ACTIVE', isDeleted: false, kycStatus: 'UNVERIFIED', role: 'ADMIN' }), 5, { requireVerifiedKyc: true },
        )).resolves.toBeUndefined();
        await expect(svc._assertLiveUserAuthorizationTx(
            txFor({ banStatus: 'ACTIVE', isDeleted: false, kycStatus: 'UNVERIFIED', role: 'USER' }), 5, { atBoundary: 'savings deposit transaction' },
        )).resolves.toBeUndefined();
    });
});

describe('exact amounts', () => {
    const SmartRouteService = require('../services/smartRouteService');
    const Svc = SmartRouteService.SmartRouteService || SmartRouteService;
    const svc = Object.create(Svc.prototype);

    test.each(['0', '-1', '1e2', '1.123456789', 'abc', 0.1 + 0.2])('refuses %p', (v) => {
        expect(() => svc._parsePositiveAmount(v)).toThrow(/amountUsdc/);
    });

    test('keeps the exact value', () => {
        const d = svc._parsePositiveAmount('25.12345678');
        expect(d).toBeInstanceOf(Prisma.Decimal);
        expect(d.toFixed(8)).toBe('25.12345678');
    });
});
