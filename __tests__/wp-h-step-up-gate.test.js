'use strict';
const { requireActionStepUp, consumeStepUp, GRANT_HEADER } = require('../middleware/requireActionStepUp');

function fakeReq({ body = {}, headers = {}, userId = 7 } = {}) {
    const store = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        user: { id: userId }, body, method: 'POST', path: '/api/withdrawals/fiat',
        originalUrl: '/api/withdrawals/fiat', baseUrl: '', get: (k) => store[String(k).toLowerCase()],
    };
}
function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const SPEC = {
    actionType: 'FIAT_WITHDRAWAL',
    routeScope: 'POST /api/withdrawals/fiat',
    currency: () => 'GHS', amount: (r) => r.body.amount,
    destination: (r) => r.body.phone, resource: null, params: () => ({}),
};

test('a request with no grant is challenged with the SERVER digest', () => {
    const req = fakeReq({ body: { amount: '100.50', phone: '+233551234567', totpToken: 'SECRET-TOTP' } });
    const res = fakeRes();
    const next = jest.fn();
    requireActionStepUp(SPEC)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    expect(res.body.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-TOTP/);
});

test('the same action yields the same digest, a changed amount does not', () => {
    const mk = (amount) => {
        const req = fakeReq({ body: { amount, phone: '+233551234567' } });
        const res = fakeRes();
        requireActionStepUp(SPEC)(req, res, jest.fn());
        return res.body.actionDigest;
    };
    expect(mk('100.50')).toBe(mk('100.50'));
    expect(mk('100.50')).not.toBe(mk('100.51'));
});

test('a grant token lets the request through and is never consumed by the gate', async () => {
    const req = fakeReq({ body: { amount: '100.50', phone: '+233551234567' }, headers: { [GRANT_HEADER]: 'tok-abc' } });
    const res = fakeRes();
    const next = jest.fn();
    requireActionStepUp(SPEC)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.stepUp.token).toBe('tok-abc');
    // consumeStepUp without a transaction must refuse, never silently succeed.
    const out = await consumeStepUp({}, req).catch((e) => ({ ok: false, reason: 'THREW' }));
    expect(out.ok).toBe(false);
});

test('missing user identity cannot produce a grantable digest', () => {
    const req = fakeReq({ body: { amount: '1.00' }, userId: undefined });
    const res = fakeRes();
    const next = jest.fn();
    requireActionStepUp(SPEC)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect([401, 503]).toContain(res.statusCode);
});
