// §WP-H G — the grant endpoint must refuse to authorise anything it cannot bind.
'use strict';

jest.mock('../src/services/totpStepClaimService', () => ({
    verifyAndClaimTotp: jest.fn(),
    sendTotpFailure: jest.fn((res, verdict, opts) => res.status(verdict && verdict.code === 'TOTP_REPLAYED' ? 409 : (opts.invalidStatus || 401)).json({ success: false, code: verdict && verdict.code })),
    sendTotpUnavailable: jest.fn((res) => res.status(503).json({ success: false, code: 'TOTP_CLAIM_STORE_UNAVAILABLE' })),
    TOTP_CODES: { UNAVAILABLE: 'TOTP_CLAIM_STORE_UNAVAILABLE', REPLAYED: 'TOTP_REPLAYED' },
}));

jest.mock('bcryptjs', () => ({ compare: jest.fn() }));

const bcrypt = require('bcryptjs');
const totp = require('../src/services/totpStepClaimService');
const controller = require('../controllers/stepUpController');

const ACTION = {
    actionType: 'FIAT_WITHDRAWAL',
    routeScope: 'POST /api/withdrawals/fiat',
    method: 'POST',
    path: '/api/withdrawals/fiat',
    currency: 'GHS',
    amount: '100.50',
    destination: '+233551234567',
    idempotencyKey: 'idem-1',
    params: { note: 'rent' },
};

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function makePrisma(user) {
    return {
        user: { findUnique: jest.fn(async () => user) },
        actionStepUpGrant: { create: jest.fn(async (args) => args.data) },
    };
}

const req = (body, user) => ({ user: { id: 7 }, body, method: 'POST', app: { get: () => makePrisma(user) } });

beforeEach(() => jest.clearAllMocks());

test('2FA user: a valid TOTP earns a grant, and the TOTP never comes back in the response', async () => {
    totp.verifyAndClaimTotp.mockResolvedValue({ ok: true });
    const res = makeRes();
    await controller.issue(req({ ...ACTION, totpToken: 'ZZ-TOTP' }, { isTwoFactorEnabled: true, twoFactorSecret: 's', password: 'h' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.stepUpGrant).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.ttlSeconds).toBe(60);
    expect(JSON.stringify(res.body)).not.toMatch(/ZZ-TOTP/);
});

test('2FA user without a token is refused before any grant', async () => {
    const res = makeRes();
    await controller.issue(req({ ...ACTION }, { isTwoFactorEnabled: true, twoFactorSecret: 's', password: 'h' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('2FA_REQUIRED');
    expect(totp.verifyAndClaimTotp).not.toHaveBeenCalled();
});

test('a replayed TOTP refuses with 409 and grants nothing', async () => {
    totp.verifyAndClaimTotp.mockResolvedValue({ ok: false, code: 'TOTP_REPLAYED' });
    const res = makeRes();
    await controller.issue(req({ ...ACTION, totpToken: 'ZZ-TOTP' }, { isTwoFactorEnabled: true, twoFactorSecret: 's', password: 'h' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.stepUpGrant).toBeUndefined();
});

test('a claim-store outage is 503, never a grant', async () => {
    totp.verifyAndClaimTotp.mockResolvedValue({ ok: false, code: 'TOTP_CLAIM_STORE_UNAVAILABLE' });
    const res = makeRes();
    await controller.issue(req({ ...ACTION, totpToken: 'ZZ-TOTP' }, { isTwoFactorEnabled: true, twoFactorSecret: 's', password: 'h' }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.stepUpGrant).toBeUndefined();
});

test('non-2FA user: password path works, wrong password refuses', async () => {
    bcrypt.compare.mockResolvedValue(true);
    const res = makeRes();
    await controller.issue(req({ ...ACTION, password: 'correct' }, { isTwoFactorEnabled: false, password: 'hash' }), res);
    expect(res.statusCode).toBe(201);

    bcrypt.compare.mockResolvedValue(false);
    const bad = makeRes();
    await controller.issue(req({ ...ACTION, password: 'wrong' }, { isTwoFactorEnabled: false, password: 'hash' }), bad);
    expect(bad.statusCode).toBe(401);
    expect(bad.body.stepUpGrant).toBeUndefined();
});

test('an action that cannot be described exactly earns nothing', async () => {
    bcrypt.compare.mockResolvedValue(true);
    const res = makeRes();
    // float money: the normaliser refuses non-string amounts
    await controller.issue(req({ ...ACTION, amount: 100.5, password: 'x' }, { isTwoFactorEnabled: false, password: 'h' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('STEP_UP_ACTION_INVALID');
});

test('the digest is bound per action: a changed amount yields a different grant binding', async () => {
    bcrypt.compare.mockResolvedValue(true);
    const one = makeRes();
    await controller.issue(req({ ...ACTION, password: 'x' }, { isTwoFactorEnabled: false, password: 'h' }), one);
    const two = makeRes();
    await controller.issue(req({ ...ACTION, amount: '100.51', password: 'x' }, { isTwoFactorEnabled: false, password: 'h' }), two);
    expect(one.body.actionDigest).not.toBe(two.body.actionDigest);
});
