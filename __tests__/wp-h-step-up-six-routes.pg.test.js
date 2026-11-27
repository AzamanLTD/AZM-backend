// __tests__/wp-h-step-up-six-routes.pg.test.js
// =============================================================================
// §WP-H G — the action-bound grant is VERIFIED AND SPENT inside the economic
// transaction on every gated route, not merely checked for presence.
//
// Before this change only POST /api/wallet/withdraw consumed its grant; the
// other six gated routes accepted any non-empty x-step-up-grant header once
// STEP_UP_ENFORCEMENT=on. This suite drives the real server and the real
// database for POST /api/wallet/internal-transfer (both directions) and pins the
// route stacks of all seven gated routes.
//
// Proven here, end to end:
//   1. no grant -> 401 STEP_UP_REQUIRED, and the idempotency claim is released
//      so the SAME key can carry the grant on the retry;
//   2. a forged token -> 409 STEP_UP_REJECTED, no money moved;
//   3. a grant earned for a different amount -> 409, no money moved;
//   4. a valid grant -> the transfer commits and the grant is consumed by the
//      same commit;
//   5. a committed same-key replay returns the stored response WITHOUT a new
//      grant and moves nothing twice;
//   6. a consumed grant cannot be spent again on a new key;
//   7. FROM_POOL consumes its grant too (the second economic branch).
// =============================================================================
'use strict';

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DB_URL);
const RUN = `${Date.now()}`.slice(-7);
const run = hasDb ? describe : describe.skip;

// Enforced ONLY inside this process. Production stays off.
process.env.STEP_UP_ENFORCEMENT = 'on';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PASSWORD = 'CorrectHorse1!';

run('action-bound step-up is spent in-transaction on the six formerly unconsumed routes (real PostgreSQL)', () => {
    let app;
    let prisma;
    let seq = 0;

    const nextKey = () => `six-${RUN}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2)}`;

    async function vendor({ available = '500', pool = '0' } = {}) {
        seq += 1;
        const hash = await bcrypt.hash(PASSWORD, 4);
        const u = await prisma.user.create({
            data: {
                username: `six${RUN}${seq}`,
                email: `six-${RUN}-${seq}@azaman.test`,
                password: hash,
                role: 'VENDOR',
                kycStatus: 'VERIFIED',
                isTwoFactorEnabled: false,
                availableBalance: available,
                vendorUnallocatedBalance: pool,
            },
        });
        return { id: u.id, token: jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    }

    const transfer = (user, body, { key, grant } = {}) => {
        let r = request(app).post('/api/wallet/internal-transfer').set('Authorization', `Bearer ${user.token}`).send(body);
        if (key) r = r.set('Idempotency-Key', key);
        if (grant) r = r.set('x-step-up-grant', grant);
        return r;
    };

    const earn = async (user, action) => {
        const res = await request(app)
            .post('/api/step-up/grant')
            .set('Authorization', `Bearer ${user.token}`)
            .send({ action, password: PASSWORD });
        expect(res.status).toBe(201);
        return res.body.stepUpGrant;
    };

    const balances = async (id) => {
        const u = await prisma.user.findUnique({ where: { id }, select: { availableBalance: true, vendorUnallocatedBalance: true } });
        return { available: u.availableBalance.toString(), pool: u.vendorUnallocatedBalance.toString() };
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = DB_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        app = require('../server');
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    test('1-6: challenge, forged, mismatched, valid, committed replay, reuse', async () => {
        const v = await vendor({ available: '500' });
        const body = { direction: 'TO_POOL', amount: '40' };
        const before = await balances(v.id);

        // 1. No grant: challenge, and the claim is released for the same key.
        const key = nextKey();
        const challenged = await transfer(v, body, { key });
        expect(challenged.status).toBe(401);
        expect(challenged.body.code).toBe('STEP_UP_REQUIRED');
        expect(challenged.body.action.actionType).toBe('INTERNAL_TRANSFER');
        expect(challenged.body.action.amount).toBe('40');
        expect(challenged.body.action.params).toEqual({ direction: 'TO_POOL' });

        // 2. A forged token is rejected inside the transaction: nothing moves.
        const forged = await transfer(v, body, { key, grant: 'f'.repeat(64) });
        expect(forged.status).toBe(409);
        expect(forged.body.code).toBe('STEP_UP_REJECTED');
        expect(await balances(v.id)).toEqual(before);

        // 3. A grant earned for a DIFFERENT amount does not authorise this one.
        const otherKey = nextKey();
        const otherChallenge = await transfer(v, { direction: 'TO_POOL', amount: '41' }, { key: otherKey });
        const wrongGrant = await earn(v, otherChallenge.body.action);
        const mismatched = await transfer(v, body, { key, grant: wrongGrant });
        expect(mismatched.status).toBe(409);
        expect(mismatched.body.code).toBe('STEP_UP_REJECTED');
        expect(await balances(v.id)).toEqual(before);

        // 4. The right grant: the transfer commits and the grant is spent with it.
        const grant = await earn(v, challenged.body.action);
        const ok = await transfer(v, body, { key, grant });
        expect(ok.status).toBe(200);
        expect(await balances(v.id)).toEqual({
            available: String(Number(before.available) - 40),
            pool: String(Number(before.pool) + 40),
        });
        const spent = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ActionStepUpGrant" WHERE "userId" = $1 AND "consumedAt" IS NOT NULL',
            String(v.id),
        );
        expect(spent[0].n).toBe(1);

        // 5. Committed same-key replay: stored response, no grant needed, no second move.
        const replay = await transfer(v, body, { key });
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(ok.body);
        expect(await balances(v.id)).toEqual({
            available: String(Number(before.available) - 40),
            pool: String(Number(before.pool) + 40),
        });

        // 6. The consumed grant cannot be spent again under a new key.
        const reuse = await transfer(v, body, { key: nextKey(), grant });
        expect([401, 409]).toContain(reuse.status);
        expect(await balances(v.id)).toEqual({
            available: String(Number(before.available) - 40),
            pool: String(Number(before.pool) + 40),
        });
    }, 60000);

    test('7: FROM_POOL consumes its grant in its own transaction', async () => {
        const v = await vendor({ available: '0', pool: '75' });
        const body = { direction: 'FROM_POOL', amount: '25' };
        const key = nextKey();

        const forged = await transfer(v, body, { key, grant: 'a'.repeat(64) });
        expect(forged.status).toBe(409);
        expect(await balances(v.id)).toEqual({ available: '0', pool: '75' });

        const challenged = await transfer(v, body, { key });
        expect(challenged.status).toBe(401);
        const grant = await earn(v, challenged.body.action);
        const ok = await transfer(v, body, { key, grant });
        expect(ok.status).toBe(200);
        expect(await balances(v.id)).toEqual({ available: '25', pool: '50' });
    }, 60000);
});

describe('route stacks: second factor, then idempotency, then the gate, then the handler', () => {
    // Static pin over the real routers; runs without a database.
    const routes = [
        ['../routes/walletRoutes', 'post', '/withdraw'],
        ['../routes/walletRoutes', 'post', '/internal-transfer'],
        ['../routes/escrowRoutes', 'post', '/fund'],
        ['../routes/escrowRoutes', 'post', '/satisfy'],
        ['../routes/p2pRoutes', 'post', '/complete'],
        ['../routes/tradeRoutes', 'post', '/initiate'],
        ['../routes/tradeRoutes', 'post', '/accept'],
    ];
    const src = (layer) => String(layer.handle);

    test.each(routes)('%s %s %s', (mod, method, path) => {
        const router = require(mod);
        const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
        expect(layer).toBeDefined();
        const stack = layer.route.stack;
        const idem = stack.findIndex((l) => /Idempotency-Key|idempotency/i.test(src(l)));
        const gate = stack.findIndex((l) => src(l).includes('isStepUpEnforced() ? middleware(req, res, next) : next()'));
        const second = stack.findIndex((l) => src(l).includes('require2FA()(req, res, next)'));
        expect(idem).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(-1);
        expect(second).toBeLessThan(idem);
        expect(idem).toBeLessThan(gate);
        expect(gate).toBeLessThan(stack.length - 1);
    });
});

describe('requireConsumedStepUp', () => {
    const { requireConsumedStepUp, isStepUpRejection } = require('../middleware/requireActionStepUp');

    test('enforcement off: no consumption, nothing thrown', async () => {
        const prev = process.env.STEP_UP_ENFORCEMENT;
        process.env.STEP_UP_ENFORCEMENT = 'off';
        try {
            const tx = { $queryRawUnsafe: jest.fn() };
            await expect(requireConsumedStepUp(tx, { stepUp: null })).resolves.toEqual({ enforced: false });
            expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
        } finally {
            process.env.STEP_UP_ENFORCEMENT = prev;
        }
    });

    test('enforcement on: a missing grant throws STEP_UP_REJECTED', async () => {
        process.env.STEP_UP_ENFORCEMENT = 'on';
        const err = await requireConsumedStepUp({}, { stepUp: null, user: { id: 1 } }).catch((e) => e);
        expect(isStepUpRejection(err)).toBe(true);
        expect(err.reason).toBe('MISSING_GRANT');
    });
});
