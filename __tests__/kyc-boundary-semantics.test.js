// __tests__/kyc-boundary-semantics.test.js
// =============================================================================
// #383 consolidation — the KYC gate's BOUNDARY semantics, proven against the
// real middleware.
//
// PR #383 shipped three test files under names that no longer exist
// (kyc-action-matrix / kyc-boundary-gate / kyc-withdrawal-surfaces). The evolved
// route-matrix suite proves route INVENTORY and ordering, but not these
// boundary rules, so they are proven here rather than assumed equivalent:
//
//   1. the required baseline is never narrowed by configuration;
//   2. an empty or unset KYC_GATED_ACTIONS still gates everything required
//      (misconfiguration must not silently disable the gate);
//   3. an out-of-scope action passes WITHOUT touching the database;
//   4. every kycStatus produces its own honest refusal, and a NULL status is
//      treated as UNVERIFIED rather than as "no gate".
// =============================================================================
'use strict';

const { requireKyc, gatedActions, REQUIRED_GATED_ACTIONS } = require('../middleware/requireKyc');

function makeReq(action, { kycStatus = 'VERIFIED', lookup = true, row = true } = {}) {
    const calls = { findUnique: 0 };
    const prisma = {
        user: {
            findUnique: async () => {
                calls.findUnique += 1;
                if (!lookup) throw new Error('lookup should not happen');
                return row ? { kycStatus, role: 'USER', isDeleted: false } : null;
            },
        },
    };
    return {
        calls,
        req: { user: { id: 'u1' }, app: { get: () => prisma } },
        action,
    };
}

function run(mw, req) {
    return new Promise((resolve) => {
        let settled = null;
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { settled = { kind: 'json', code: this.statusCode, body }; return this; },
        };
        const next = () => { settled = { kind: 'next' }; };
        mw(req, res, next).then(() => {
            // next() is synchronous inside the promise chain in some paths
            setTimeout(() => resolve(settled), 0);
        });
    });
}

describe('#383 — KYC gate boundary semantics', () => {
    beforeEach(() => { delete process.env.KYC_GATED_ACTIONS; });
    afterAll(() => { delete process.env.KYC_GATED_ACTIONS; });

    test('the required money-moving baseline is always gated', () => {
        const gated = gatedActions();
        for (const action of REQUIRED_GATED_ACTIONS) expect(gated.has(action)).toBe(true);
        expect(REQUIRED_GATED_ACTIONS).toEqual(
            expect.arrayContaining(['withdraw', 'deposit', 'p2p', 'trade', 'susu', 'pay']),
        );
    });

    test('an UNSET env still gates every required action', async () => {
        const { req } = makeReq('withdraw', { kycStatus: 'UNVERIFIED' });
        const out = await run(requireKyc('withdraw'), req);
        expect(out.kind).toBe('json');
        expect(out.code).toBe(403);
        expect(out.body.code).toBe('KYC_REQUIRED');
    });

    test('an EMPTY env does not disable the gate', async () => {
        process.env.KYC_GATED_ACTIONS = '   ';
        const { req } = makeReq('trade', { kycStatus: 'UNVERIFIED' });
        const out = await run(requireKyc('trade'), req);
        expect(out.code).toBe(403);
    });

    test('a narrowed env keeps the baseline and only ADDS coverage', () => {
        process.env.KYC_GATED_ACTIONS = 'send_gift';
        const gated = gatedActions();
        expect(gated.has('send_gift')).toBe(true);           // added
        for (const a of REQUIRED_GATED_ACTIONS) expect(gated.has(a)).toBe(true); // never removed
    });

    test('an out-of-scope action passes WITHOUT touching the database', async () => {
        const { req, calls } = makeReq('read_messages', { lookup: false });
        const out = await run(requireKyc('read_messages'), req);
        expect(out.kind).toBe('next');
        expect(calls.findUnique).toBe(0);
    });

    test('VERIFIED passes straight through', async () => {
        const { req } = makeReq('withdraw', { kycStatus: 'VERIFIED' });
        const out = await run(requireKyc('withdraw'), req);
        expect(out.kind).toBe('next');
    });

    test('UNVERIFIED is refused naming the action, never as a generic 401', async () => {
        const { req } = makeReq('susu', { kycStatus: 'UNVERIFIED' });
        const out = await run(requireKyc('susu'), req);
        expect(out.code).toBe(403);
        expect(out.body.code).toBe('KYC_REQUIRED');
        expect(out.body.requiredFor).toBe('susu');
    });

    test('PENDING is refused as under review, not as "not started"', async () => {
        const { req } = makeReq('deposit', { kycStatus: 'PENDING' });
        const out = await run(requireKyc('deposit'), req);
        expect(out.code).toBe(403);
        expect(out.body.kycStatus).toBe('PENDING');
        expect(String(out.body.message)).toMatch(/review|pending/i);
    });

    test('REJECTED asks for a resubmission', async () => {
        const { req } = makeReq('p2p', { kycStatus: 'REJECTED' });
        const out = await run(requireKyc('p2p'), req);
        expect(out.code).toBe(403);
        expect(String(out.body.message)).toMatch(/resubmit|again|reject/i);
    });

    test('a NULL kycStatus is treated as UNVERIFIED, not as an exemption', async () => {
        const { req } = makeReq('pay', { kycStatus: null });
        const out = await run(requireKyc('pay'), req);
        expect(out.code).toBe(403);
        expect(out.body.code).toBe('KYC_REQUIRED');
    });

    test('a missing identity row fails closed rather than passing', async () => {
        const { req } = makeReq('withdraw', { row: false });
        const out = await run(requireKyc('withdraw'), req);
        expect(out.kind).toBe('json');
        expect(out.code).toBeGreaterThanOrEqual(400);
    });
});
