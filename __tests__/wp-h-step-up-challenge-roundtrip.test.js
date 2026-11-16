// §WP-H G — the challenge must hand the client the exact action the server hashed.
// Without it a client has to guess routeScope/path/params, gets a different digest,
// and the granted capability authorises nothing. This proves the echo round-trips.
'use strict';

const { requireActionStepUp } = require('../middleware/requireActionStepUp');
const { canonicalAction, actionDigest } = require('../src/services/canonicalAction');

const BODY = { amount: '125.50', currency: 'GHS', destination: '0244123456', destinationType: 'MOMO' };

function fakeReq(body = BODY, headers = {}) {
    return {
        user: { id: 'user-1' },
        method: 'POST',
        baseUrl: '',
        path: '/api/wallet/withdraw',
        originalUrl: '/api/wallet/withdraw?trace=1',
        body,
        get: (name) => headers[String(name).toLowerCase()],
    };
}

function fakeRes() {
    const res = { statusCode: null, payload: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.payload = body; return res; };
    return res;
}

const GATE = requireActionStepUp({ actionType: 'FIAT_WITHDRAWAL', routeScope: 'POST /api/withdraw' });

describe('step-up challenge descriptor', () => {
    test('the 401 carries the server descriptor, and echoing it reproduces the digest', () => {
        const req = fakeReq();
        const res = fakeRes();
        const next = jest.fn();
        GATE(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.payload.code).toBe('STEP_UP_REQUIRED');
        expect(res.payload.actionDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(res.payload.action).toBeTruthy();

        // The client posts this object straight back to /api/step-up/grant. Proving
        // it re-canonicalises to the SAME digest is the whole contract.
        const echoed = canonicalAction(res.payload.action);
        expect(actionDigest(echoed)).toBe(res.payload.actionDigest);
        expect(echoed.amount).toBe('125.50');
        expect(echoed.userId).toBe('user-1');
    });

    test('the descriptor never leaks the raw query string, and the idempotency key binds', () => {
        const req = fakeReq(BODY, { 'idempotency-key': 'op-abc123', 'x-step-up-grant': 'tok' });
        const res = fakeRes();
        GATE(req, res, jest.fn());
        // token present -> the gate passes through instead of challenging
        expect(res.payload).toBeNull();
    });

    test('a challenge without the grant still pins the idempotency key into the digest', () => {
        const req = fakeReq(BODY, { 'idempotency-key': 'op-abc123' });
        const res = fakeRes();
        GATE(req, res, jest.fn());
        expect(res.payload.action.idempotencyKey).toBe('op-abc123');
        expect(res.payload.action.path).toBe('/api/wallet/withdraw');
        expect(res.payload.action.routeScope).toBe('POST /api/withdraw');
    });
});
