// __tests__/finance-deposit-webhook-retired.test.js
// =============================================================================
// POST /api/finance/webhook/deposit is retired.
//
// The route used to credit a body-supplied userId with no authentication. It
// must now refuse every request with 410 before touching any state. These
// tests mount the REAL finance router and give the app a prisma client, a
// socket server and a balance emitter that throw on any use: a 410 with none
// of them touched proves no read and no write can happen, whatever the body.
//
// A second real-PostgreSQL proof (skipped without TEST_DATABASE_URL) shows a
// forged credit leaves the user's balance and history untouched.
// =============================================================================
const express = require('express');
const request = require('supertest');

const hasDb = !!process.env.TEST_DATABASE_URL;
const testIf = (cond, name, fn, timeout) => (cond ? test(name, fn, timeout) : test.skip(name, fn, timeout));

function trap(label, touched) {
    return new Proxy(function () {}, {
        get(_target, prop) {
            if (prop === 'then') return undefined; // not a thenable
            touched.push(`${label}.${String(prop)}`);
            throw new Error(`${label} must not be touched (accessed ${String(prop)})`);
        },
        apply() {
            touched.push(`${label}()`);
            throw new Error(`${label} must not be called`);
        },
    });
}

function buildApp({ prisma, touched }) {
    const app = express();
    app.use(express.json());
    app.set('prisma', prisma || trap('prisma', touched));
    app.set('socketio', trap('socketio', touched));
    app.set('emitBalanceUpdate', trap('emitBalanceUpdate', touched));
    app.set('notificationService', trap('notificationService', touched));
    app.use('/api/finance', require('../routes/financeRoutes'));
    return app;
}

const forgedBodies = [
    { amount: '1000000', txHash: '0xforged-1', userId: 1 },
    { amount: 5, txHash: '0xforged-2', userId: '2', address: '0xabc' },
    { amount: '-1', txHash: '0xforged-3', userId: 3 },
    {},
];

describe('retired deposit webhook: refuses before any state access', () => {
    test.each(forgedBodies)('POST %j → 410 DEPOSIT_WEBHOOK_RETIRED, nothing touched', async (body) => {
        const touched = [];
        const res = await request(buildApp({ touched }))
            .post('/api/finance/webhook/deposit')
            .send(body);

        expect(res.status).toBe(410);
        expect(res.body).toEqual({
            success: false,
            code: 'DEPOSIT_WEBHOOK_RETIRED',
            message: 'This endpoint has been retired. Nothing was credited.',
        });
        expect(touched).toEqual([]);
    });

    test('the route is bound to the retired handler, and the crediting handler is gone', () => {
        const router = require('../routes/financeRoutes');
        const controller = require('../controllers/finance.controller');
        const layer = router.stack.find((l) => l.route && l.route.path === '/webhook/deposit');

        expect(layer).toBeDefined();
        const handlers = layer.route.stack.map((s) => s.handle);
        expect(handlers).toEqual([controller.retiredCryptoDepositWebhook]);
        expect(controller.cryptoDepositWebhook).toBeUndefined();
    });

    test('the verified Tatum deposit webhook stays mounted', () => {
        const router = require('../routes/financeRoutes');
        const paths = router.stack.map((l) => l.route && l.route.path).filter(Boolean);
        expect(paths).toContain('/webhook/tatum');
    });
});

describe('retired deposit webhook: real PostgreSQL', () => {
    let prisma;
    let user;

    beforeAll(async () => {
        if (!hasDb) return;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
        const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
        user = await prisma.user.create({
            data: {
                username: `retired_webhook_${suffix}`,
                email: `retired_webhook_${suffix}@test.local`,
                password: 'x',
            },
        });
    });

    afterAll(async () => {
        if (!hasDb) return;
        if (user) {
            await prisma.transactionHistory.deleteMany({ where: { userId: user.id } });
            await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    testIf(hasDb, 'a forged credit leaves balance and history untouched', async () => {
        const before = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true },
        });
        const txHash = `0xforged-pg-${user.id}`;

        const touched = [];
        const res = await request(buildApp({ prisma, touched }))
            .post('/api/finance/webhook/deposit')
            .send({ amount: '1000', txHash, userId: user.id });

        expect(res.status).toBe(410);
        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true },
        });
        expect(after.availableBalance.toString()).toBe(before.availableBalance.toString());
        expect(await prisma.transactionHistory.count({ where: { txHash } })).toBe(0);
    }, 30000);
});
