// §B5 — THE SIX NEW MOUNTS, AND THE BINDING THE ROUTE ITSELF PRODUCES.
//
// 6f65f2e8 mounted the gate on six routes. The CONSUME contract (single use,
// expiry, wrong user, every material field bound, concurrent single winner,
// rollback) is already proved against real PostgreSQL in
// wp-h-action-step-up.test.js, so it is NOT duplicated here.
//
// What was unproved is the MOUNT: that each route actually reaches the gate, with
// its own action type, and that the digest the route computes is bound to the
// resource a client cannot swap and is unaffected by the credential the earlier
// middleware strips. Those are the properties this suite asserts.
//
// A wrong-resource grant cannot be refused at the route: the gate only issues
// challenges, and the grant is spent inside the handler's own transaction, which
// a non-existent escrow never reaches. Asserting a refusal here would be
// asserting a 404.
'use strict';

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DB_URL);
const RUN = `${Date.now()}`.slice(-7);
const run = hasDb ? describe : describe.skip;

process.env.STEP_UP_ENFORCEMENT = 'on';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PASSWORD = 'CorrectHorse1!';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

run('§B5 step-up mounts (real routes, enforcement ON in-process)', () => {
    let app;
    let prisma;
    let seq = 0;

    const makeUser = async () => {
        seq += 1;
        const hash = await bcrypt.hash(PASSWORD, 4);
        const user = await prisma.user.create({
            data: {
                username: `ef${RUN}${seq}`,
                email: `b5-mount-${RUN}-${seq}@azaman.test`,
                password: hash,
                availableBalance: 5000,
                kycStatus: 'VERIFIED',
                isTwoFactorEnabled: false,
            },
        });
        return { userId: user.id, token: jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    };

    /** POST a body with the password re-confirmation require2FA demands. */
    // The digest is bound to the idempotency key, so a retry must REUSE the key.
    // A fixed key is how these tests compare two digests for the same action.
    const post = (path, body, token, password = PASSWORD, key) =>
        request(app).post(path)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', key || `b5-${Date.now()}-${Math.random().toString(36).slice(2)}`)
            .send({ ...body, password });

    beforeAll(async () => {
        process.env.DATABASE_URL = DB_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        app = require('../server');
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
    }, 60000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    test('escrow funding is challenged with ESCROW_FUND bound to the escrow', async () => {
        const { token } = await makeUser();
        const escrowId = uuid(101);
        const res = await post('/api/escrow/fund', { escrowId }, token);

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('STEP_UP_REQUIRED');
        expect(res.body.actionType).toBe('ESCROW_FUND');
        expect(res.body.action.resource).toBe(escrowId);
        expect(typeof res.body.actionDigest).toBe('string');
    }, 60000);

    test('the digest is bound to the escrow: swapping the resource changes it', async () => {
        const { token } = await makeUser();
        const KEY = `fixed-${Date.now()}`;
        const a = await post('/api/escrow/fund', { escrowId: uuid(201) }, token, PASSWORD, KEY);
        const b = await post('/api/escrow/fund', { escrowId: uuid(202) }, token, PASSWORD, KEY);

        expect(a.body.actionType).toBe('ESCROW_FUND');
        expect(b.body.actionType).toBe('ESCROW_FUND');
        expect(a.body.actionDigest).not.toBe(b.body.actionDigest);
        // Repeating the SAME request must reproduce the SAME digest, or a client
        // could never earn a grant and then retry the action it names.
        const again = await post('/api/escrow/fund', { escrowId: uuid(201) }, token, PASSWORD, KEY);
        expect(again.body.actionDigest).toBe(a.body.actionDigest);
    }, 60000);

    test('the password re-confirmation is stripped, so it cannot perturb the digest', async () => {
        const { token } = await makeUser();
        const escrowId = uuid(301);
        const withReal = await post('/api/escrow/fund', { escrowId }, token, PASSWORD);
        // require2FA compares and then deletes req.body.password before the gate.
        // A different-but-wrong password is refused BEFORE the gate, so the only
        // way to compare two digests is the same valid password twice; the point
        // is that no password material reaches the digest, which the canonical
        // action's shape proves by carrying no password field.
        expect(withReal.body.code).toBe('STEP_UP_REQUIRED');
        const action = withReal.body.action;
        expect(Object.keys(action)).not.toContain('password');
        expect(Object.keys(action)).not.toContain('totpToken');
        expect(JSON.stringify(action)).not.toContain(PASSWORD);
    }, 60000);

    test('each of the six wired routes emits its own action type', async () => {
        const { token } = await makeUser();
        const escrowId = uuid(401);

        const cases = [
            { path: '/api/p2p/complete', body: { tradeId: 1 }, expect: 'P2P_TRADE_COMPLETE' },
            { path: '/api/trades/initiate', body: { listingId: uuid(402) }, expect: 'TRADE_INITIATE' },
            { path: '/api/trades/accept', body: { tradeId: uuid(403) }, expect: 'TRADE_ACCEPT' },
            { path: '/api/escrow/fund', body: { escrowId }, expect: 'ESCROW_FUND' },
            { path: '/api/escrow/satisfy', body: { escrowId }, expect: 'ESCROW_RELEASE' },
            { path: '/api/wallet/internal-transfer', body: { direction: 'TO_POOL', amount: '5' }, expect: 'INTERNAL_TRANSFER' },
        ];

        const observed = [];
        for (const c of cases) {
            const res = await post(c.path, c.body, token);
            observed.push({ path: c.path, status: res.status, code: res.body.code,
                actionType: res.body.actionType, message: res.body.message });
        }

        // Every wired route must reach the gate. A route that returned anything
        // else is reported by name rather than silently tolerated.
        for (const c of cases) {
            const seen = observed.find((o) => o.path === c.path);
            expect({ path: c.path, code: seen.code }).toEqual({ path: c.path, code: 'STEP_UP_REQUIRED' });
            expect({ path: c.path, actionType: seen.actionType }).toEqual({ path: c.path, actionType: c.expect });
        }
    }, 90000);
});
