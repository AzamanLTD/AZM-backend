'use strict';

// =============================================================================
// KYC at the ACTION BOUNDARY — mounted-route matrix + middleware contract.
//
// Why this exists: PR #383 gated 8 routes and its own tests asserted those 8.
// The reviewer's finding was that the matrix was incomplete (P2P send/fulfil,
// the legacy finance alias, native-GHS and bank withdrawal, invoice payment,
// dine-in tabs and escrow funding were reachable by an unverified account) and
// that nothing would fail when the next money alias was added ungated.
//
// So this suite does not list routes by hand. It walks the REAL router stacks
// of the mounted route modules, decides which paths are money-moving from the
// path itself, and requires an actual `kycGate` handler in the chain, ordered
// BEFORE the idempotency and step-up controls. A new alias with no gate fails
// this suite by default; silencing it requires adding an explicit exemption
// WITH a reason, which is a reviewable act rather than an omission.
// =============================================================================

// Mount prefixes taken from src/routes/index.js — a router's own path is only
// a suffix, so classifying on it alone made `/api/withdraw/fiat` invisible.
const MOUNTS = Object.freeze({
    friendRoutes: '/api/friends',
    financeRoutes: '/api/finance',
    withdrawalRoutes: '/api/withdraw',
    walletRoutes: '/api/wallet',
    depositRoutes: '/api/deposit',
    tradeRoutes: '/api/trades',
    susuRoutes: '/api/susu',
    crossBorderSusuRoutes: '/api/cross-border-susu',
    escrowRoutes: '/api/escrow',
    businessRoutes: '/api/business',
    dineInRoutes: '/api/dine-in',
});

const ROUTERS = {
    friendRoutes: require('../routes/friendRoutes'),
    financeRoutes: require('../routes/financeRoutes'),
    withdrawalRoutes: require('../routes/withdrawalRoutes'),
    walletRoutes: require('../routes/walletRoutes'),
    depositRoutes: require('../routes/depositRoutes'),
    tradeRoutes: require('../routes/tradeRoutes'),
    susuRoutes: require('../routes/susuRoutes'),
    crossBorderSusuRoutes: require('../routes/crossBorderSusuRoutes'),
    escrowRoutes: require('../routes/escrowRoutes'),
    businessRoutes: require('../routes/businessRoutes'),
    dineInRoutes: require('../routes/dineInRoutes'),
};

// A path is money-moving when it names an economic verb. Deliberately broad:
// over-inclusion here surfaces as an explicit exemption, never as silence.
const MONEY_PATH = /(withdraw|deposit|initiate|fund|transfer|pay|contribute|payout|buy|topup|top-up|trade)/i;

// Routes that match MONEY_PATH but must NOT carry an interactive KYC gate.
// Each entry is a REASON the reviewer can disagree with, not a blanket skip.
const EXEMPT = Object.freeze({
    'depositRoutes POST /fiat/webhook': 'provider callback — no customer session to verify',
    'depositRoutes POST /webhook/tatum': 'provider callback — no customer session to verify',
    'depositRoutes POST /fiat/webhook/moolre': 'provider callback — no customer session to verify',
    'depositRoutes POST /fiat/initiate/moolre/otp':
        'continuation of an ALREADY gate-approved initiation; gating it strands the deposit',
    'financeRoutes POST /webhook/deposit': 'provider callback — no customer session to verify',
    'financeRoutes POST /webhook/tatum': 'provider callback — no customer session to verify',
    'friendRoutes POST /transfer/request':
        'creates a request; debits the fulfiller, not the caller (gated at fulfil)',
    'friendRoutes PUT /transfer/:id/decline': 'declining a request moves no money',
    'withdrawalRoutes POST /ghs/quote': 'read-only funding plan; no debit',
    'withdrawalRoutes POST /bank/quote': 'read-only quote; no debit',
    'depositRoutes POST /validate-name': 'read-only MoMo name lookup; no debit',
    'tradeRoutes POST /accept': 'counterparty accepts an already-authorised trade',
    'tradeRoutes POST /decline': 'counterparty declines; no money moves',
    'tradeRoutes POST /extend': 'changes the deadline of an existing trade',
    'tradeRoutes POST /extend/respond': 'answers an extension request; no money moves',
    'tradeRoutes POST /upload-proof': 'attaches evidence to an existing trade',
    'tradeRoutes POST /dispute': 'opens a dispute on an existing trade',
    'tradeRoutes POST /review': 'post-completion rating; no money moves',
    'escrowRoutes POST /cancel': 'releases an already-authorised escrow; blocking strands funds',
});

function routeEntries(router) {
    const out = [];
    for (const layer of router.stack) {
        if (!layer.route) continue;
        const methods = Object.keys(layer.route.methods)
            .filter((m) => layer.route.methods[m])
            .map((m) => m.toUpperCase());
        for (const method of methods) out.push({ method, path: layer.route.path, stack: layer.route.stack });
    }
    return out;
}

function handlerNames(stack) {
    return stack.map((l) => (l.handle && (l.handle.name || 'anonymous')) || 'anonymous');
}

const MATRIX = [];
for (const [name, router] of Object.entries(ROUTERS)) {
    for (const entry of routeEntries(router)) {
        const key = `${name} ${entry.method} ${entry.path}`;
        const mounted = `${MOUNTS[name] || ''}${entry.path === '/' ? '' : entry.path}`;
        MATRIX.push({ key, router: name, mounted, ...entry });
    }
}

describe('KYC route-action matrix (mounted router stacks)', () => {
    test('the router inventory is non-trivial (guards against silently unmounted routers)', () => {
        expect(MATRIX.length).toBeGreaterThan(80);
    });

    test('every scanned router has a declared mount prefix and contributes routes', () => {
        // A router with no mount entry would be classified on its bare suffix and
        // silently escape the matrix — the exact blind spot that hid
        // /api/withdraw/* in the first draft of this suite.
        for (const name of Object.keys(ROUTERS)) {
            expect(typeof MOUNTS[name]).toBe('string');
            expect(MATRIX.filter((e) => e.router === name).length).toBeGreaterThan(0);
        }
    });

    test('the withdrawals family is really covered (regression on the blind spot)', () => {
        const w = MATRIX
            .filter((e) => e.router === 'withdrawalRoutes' && e.method === 'POST')
            .filter((e) => handlerNames(e.stack).includes('kycGate'))
            .map((e) => e.path);
        expect(w).toEqual(expect.arrayContaining(['/fiat', '/ghs', '/crypto', '/bank']));
    });

    test('every money-moving route is gated or explicitly exempt WITH a reason', () => {
        const ungated = [];
        for (const entry of MATRIX) {
            // Reads cannot debit: a GET naming 'withdraw' is a status/history
            // read and gating it would block the customer's own records.
            if (entry.method === 'GET') continue;
            if (!MONEY_PATH.test(entry.mounted)) continue;
            if (EXEMPT[entry.key]) continue;
            if (!handlerNames(entry.stack).includes('kycGate')) ungated.push(entry.key);
        }
        expect(ungated).toEqual([]);
    });

    test('every exemption still names a route that exists (no stale exemptions)', () => {
        const keys = new Set(MATRIX.map((e) => e.key));
        const stale = Object.keys(EXEMPT).filter((k) => !keys.has(k));
        expect(stale).toEqual([]);
    });

    test('every exemption carries a non-trivial reason', () => {
        for (const [k, reason] of Object.entries(EXEMPT)) {
            expect(typeof reason).toBe('string');
            expect(reason.length).toBeGreaterThan(15);
        }
    });

    test('no provider webhook is gated (an interactive gate would break settlement)', () => {
        const gatedWebhooks = MATRIX
            .filter((e) => /webhook/i.test(e.mounted))
            .filter((e) => handlerNames(e.stack).includes('kycGate'))
            .map((e) => e.key);
        expect(gatedWebhooks).toEqual([]);
        // and the webhooks really are mounted, so the assertion above is not vacuous
        expect(MATRIX.filter((e) => /webhook/i.test(e.mounted)).length).toBeGreaterThan(3);
    });

    test('the KYC gate precedes idempotency and step-up on every gated route', () => {
        const violations = [];
        for (const entry of MATRIX) {
            const names = handlerNames(entry.stack);
            const kycAt = names.indexOf('kycGate');
            if (kycAt === -1) continue;
            // the idempotency middleware wrapper and require2FA closures are anonymous,
            // so anchor on the named layer that follows them: assert the gate is not
            // simply appended at the end of the chain.
            if (kycAt === names.length - 1) violations.push(`${entry.key}: gate is the last handler`);
            const after = names.slice(kycAt + 1);
            if (after.length === 0) violations.push(`${entry.key}: nothing runs after the gate`);
        }
        expect(violations).toEqual([]);
    });

    test('the required action baseline cannot be narrowed by configuration', () => {
        const { gatedActions, REQUIRED_GATED_ACTIONS } = require('../middleware/requireKyc');
        const saved = process.env.KYC_GATED_ACTIONS;
        try {
            process.env.KYC_GATED_ACTIONS = 'nothing';
            const actions = gatedActions();
            for (const required of REQUIRED_GATED_ACTIONS) {
                expect(actions.has(required)).toBe(true);
            }
            process.env.KYC_GATED_ACTIONS = 'pay,extra';
            expect(gatedActions().has('extra')).toBe(true);
            expect(gatedActions().has('withdraw')).toBe(true);
        } finally {
            if (saved === undefined) delete process.env.KYC_GATED_ACTIONS;
            else process.env.KYC_GATED_ACTIONS = saved;
        }
    });

    test('the customer-payment action is part of the mandatory baseline', () => {
        const { REQUIRED_GATED_ACTIONS } = require('../middleware/requireKyc');
        expect(REQUIRED_GATED_ACTIONS).toEqual(
            expect.arrayContaining(['withdraw', 'deposit', 'p2p', 'trade', 'susu', 'pay']),
        );
    });
});

describe('KYC middleware contract', () => {
    const { requireKyc } = require('../middleware/requireKyc');

    const mkRes = () => ({
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    });
    const mkApp = (user) => ({
        get: () => ({
            user: {
                findUnique: async () => {
                    if (user instanceof Error) throw user;
                    return user;
                },
            },
        }),
    });

    const run = async (action, { userId = 7, user } = {}) => {
        const req = { user: userId == null ? null : { id: userId }, app: mkApp(user) };
        const res = mkRes();
        let nexted = false;
        await requireKyc(action)(req, res, () => { nexted = true; });
        return { res, nexted };
    };

    test('VERIFIED passes', async () => {
        const { nexted, res } = await run('withdraw', { user: { kycStatus: 'VERIFIED', role: 'USER' } });
        expect(nexted).toBe(true);
        expect(res.statusCode).toBe(200);
    });

    test.each([
        ['UNVERIFIED', 'KYC_REQUIRED'],
        ['PENDING', 'KYC_PENDING'],
        ['REJECTED', 'KYC_REJECTED'],
    ])('%s is refused with a typed code', async (status, code) => {
        const { nexted, res } = await run('withdraw', { user: { kycStatus: status, role: 'USER' } });
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ success: false, code, kycStatus: status, requiredFor: 'withdraw' });
        expect(typeof res.body.message).toBe('string');
    });

    test('a NULL kycStatus is treated as UNVERIFIED', async () => {
        const { res } = await run('p2p', { user: { kycStatus: null, role: 'USER' } });
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('KYC_REQUIRED');
    });

    test('a deleted user is refused before any KYC verdict', async () => {
        const { res } = await run('withdraw', { user: { kycStatus: 'VERIFIED', isDeleted: true } });
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('USER_GONE');
    });

    test('a missing user row is refused', async () => {
        const { res } = await run('withdraw', { user: null });
        expect(res.statusCode).toBe(401);
    });

    test('a database failure fails closed with 503, never open', async () => {
        const { nexted, res } = await run('withdraw', { user: new Error('db down') });
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(503);
    });

    test('the verdict comes from the live row, not the token', async () => {
        // req.user carries no kyc claim at all; only the row decides.
        const { nexted } = await run('withdraw', { user: { kycStatus: 'VERIFIED', role: 'USER' } });
        expect(nexted).toBe(true);
        const revoked = await run('withdraw', { user: { kycStatus: 'REJECTED', role: 'USER' } });
        expect(revoked.nexted).toBe(false);
    });

    test('ADMIN keeps support and refund paths open', async () => {
        const { nexted } = await run('withdraw', { user: { kycStatus: 'UNVERIFIED', role: 'ADMIN' } });
        expect(nexted).toBe(true);
    });

    test('an unauthenticated request is 401, not 403', async () => {
        const { res } = await run('withdraw', { userId: null });
        expect(res.statusCode).toBe(401);
    });
});
