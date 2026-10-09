// __tests__/r272-corporate-purchase-idempotency.test.js
// =============================================================================
// r272 finding 2 — corporate treasury purchase, real-PostgreSQL proof of the
// shared-idempotency-authority + exact-decimal fixes.
//
// Pre-fix defects:
//   • Both /war-room/corporate-purchase routes wrote money with NO
//     idempotency protection: a retried POST (double-click, network retry,
//     replay) wrote a second CorporatePurchaseLog and credited
//     SystemMasterCrypto a second time. The API path's unique
//     gatewayReference only rejected replays that re-sent the SAME
//     reference — the auto-generated reference is fresh per request, so it
//     protected nothing.
//   • Money moved as binary floats: parseFloat + increment-by-float against
//     Decimal(20,8) columns (0.1+0.2 drift, silent 17-digit representations).
//
// Post-fix contract proven here, through the REAL middleware + REAL handler
// (express app, real Prisma + PostgreSQL):
//   1. No Idempotency-Key → 400 before any economics; nothing written.
//   2. Same key + same body, replayed after commit → replay of the committed
//      201 body; exactly ONE purchase row and ONE treasury credit.
//   3. Two concurrent POSTs with the same key → exactly one 201, one 409
//      IN_PROGRESS; one row, one credit.
//   4. Same key + materially different body → deterministic 409, nothing
//      re-executed.
//   5. Same coverage for the Kotani API path (live-rates quote).
//   6. Exact money: 0.1 + 0.2 credit lands as the exact 8dp decimal, and
//      non-exact / negative / exponent inputs are refused before economics.
//
// Against the pre-fix implementation tests 2 and 3 fail (double credit) and
// test 6 fails (float drift and silent acceptance of inexact input).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r272-corporate-purchase] TEST_DATABASE_URL not set — skipping.');

const express = require('express');
const request = require('supertest');

describeOrSkip('r272 corporate purchase idempotency + exact money (real PostgreSQL)', () => {
    let prisma, app, admin;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        admin = await prisma.user.create({
            data: {
                username: `r272corp_admin_${uniq}`,
                email: `r272corp_admin_${uniq}@test.local`,
                password: 'test_password',
                role: 'ADMIN',
            },
        });

        const { idempotency } = require('../middleware/idempotency');
        const warRoomController = require('../controllers/warRoomController');

        app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = { id: admin.id, role: 'ADMIN', username: 'admin' };
            req.app.set('prisma', prisma);
            req.app.set('gatewayService', {
                fetchOfframpRates: async () => ({
                    provider: 'KOTANI_PAY',
                    source: 'test',
                    corporateRate: 15.5,
                    retailRate: 16.5,
                }),
            });
            next();
        });
        app.post(
            '/corporate-purchase',
            idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, identity: 'POST /api/war-room/corporate-purchase' }),
            warRoomController.logCorporatePurchase
        );
        app.post(
            '/corporate-purchase/api',
            idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, identity: 'POST /api/war-room/corporate-purchase/api' }),
            warRoomController.purchaseCorporateViaApi
        );
    });

    afterAll(async () => {
        if (!prisma) return;
        await prisma.corporatePurchaseLog.deleteMany({ where: { adminId: admin.id } });
        await prisma.financialOperation.deleteMany({ where: { userId: admin.id } });
        await prisma.user.deleteMany({ where: { id: admin.id } });
        await prisma.systemMasterCrypto.deleteMany({ where: { id: 1 } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        // Fresh treasury singleton and a clean slate for the rows this suite owns.
        await prisma.financialOperation.deleteMany({ where: { userId: admin.id } });
        await prisma.corporatePurchaseLog.deleteMany({ where: { adminId: admin.id } });
        await prisma.systemMasterCrypto.deleteMany({ where: { id: 1 } });
    });

    async function masterBalance() {
        const m = await prisma.systemMasterCrypto.findUnique({ where: { id: 1 } });
        return m ? m.balance.toFixed(8) : '0.00000000';
    }

    const manualBody = {
        usdcAmount: '10.5',
        fiatSentTotal: '168.00',
        discountRate: '0.05',
        actualMarketRate: '16.00',
    };

    test('no Idempotency-Key → 400 before economics, nothing written', async () => {
        const res = await request(app).post('/corporate-purchase').send(manualBody);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
        expect(await prisma.corporatePurchaseLog.count({ where: { adminId: admin.id } })).toBe(0);
        expect(await masterBalance()).toBe('0.00000000');
    });

    test('replayed same-key commit → one row, one credit, replayed body', async () => {
        const key = `r272-replay-${Date.now()}`;
        const first = await request(app).post('/corporate-purchase').set('Idempotency-Key', key).send(manualBody);
        expect(first.status).toBe(201);
        expect(first.body.success).toBe(true);

        const second = await request(app).post('/corporate-purchase').set('Idempotency-Key', key).send(manualBody);
        expect(second.status).toBe(201); // committed replay
        expect(second.body).toEqual(first.body); // byte-fidelity contract

        expect(await prisma.corporatePurchaseLog.count({ where: { adminId: admin.id } })).toBe(1);
        expect(await masterBalance()).toBe('10.50000000'); // credited ONCE, exact 8dp
    });

    test('two concurrent same-key POSTs → exactly one commits, one 409', async () => {
        const key = `r272-race-${Date.now()}`;
        const [a, b] = await Promise.all([
            request(app).post('/corporate-purchase').set('Idempotency-Key', key).send(manualBody),
            request(app).post('/corporate-purchase').set('Idempotency-Key', key).send(manualBody),
        ]);
        const statuses = [a.status, b.status].sort();
        // The unique INSERT is the arbiter: overlapping claims → [201, 409
        // IN_PROGRESS]; if the second claim lands after the first commit it
        // replays the committed result → [201, 201] with identical bodies.
        // Both are exactly-once outcomes. What is IMPOSSIBLE post-fix (and
        // happened pre-fix) is two independent executions.
        expect(statuses[0]).toBe(201);
        expect(statuses[1]).toBeGreaterThanOrEqual(201);
        expect(statuses.every((st) => st === 201 || st === 409)).toBe(true);
        if (a.status === 201 && b.status === 201) {
            expect(b.body).toEqual(a.body); // replayed committed body, not a second execution
        } else {
            const conflict = a.status === 409 ? a : b;
            expect(conflict.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        }

        expect(await prisma.corporatePurchaseLog.count({ where: { adminId: admin.id } })).toBe(1);
        expect(await masterBalance()).toBe('10.50000000'); // treasury credited EXACTLY once
    });

    test('same key, materially different body → 409 PAYLOAD conflict, no re-execution', async () => {
        const key = `r272-conflict-${Date.now()}`;
        const first = await request(app).post('/corporate-purchase').set('Idempotency-Key', key).send(manualBody);
        expect(first.status).toBe(201);

        const second = await request(app)
            .post('/corporate-purchase')
            .set('Idempotency-Key', key)
            .send({ ...manualBody, usdcAmount: '999.99' });
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');

        expect(await prisma.corporatePurchaseLog.count({ where: { adminId: admin.id } })).toBe(1);
        expect(await masterBalance()).toBe('10.50000000'); // the 999.99 never executed
    });

    test('API path: replayed same-key quote → one row, one credit', async () => {
        const key = `r272-api-${Date.now()}`;
        const first = await request(app).post('/corporate-purchase/api').set('Idempotency-Key', key).send({ fiatGhs: '155.00' });
        expect(first.status).toBe(201);
        // 155 / 15.5 = 10 exactly — exact-decimal division, not float math
        // (pre-fix parseFloat produced 10.000000000000002-style drift).
        expect(first.body.data.quote.usdcAmount).toBe('10');

        const second = await request(app).post('/corporate-purchase/api').set('Idempotency-Key', key).send({ fiatGhs: '155.00' });
        expect(second.status).toBe(201);
        expect(second.body).toEqual(first.body);

        expect(await prisma.corporatePurchaseLog.count({ where: { adminId: admin.id } })).toBe(1);
        expect(await masterBalance()).toBe('10.00000000');
    });

    test('exact money: 0.1 + 0.2 credits land as the exact 8dp decimal', async () => {
        const k1 = `r272-exact1-${Date.now()}`;
        const k2 = `r272-exact2-${Date.now()}`;
        const r1 = await request(app).post('/corporate-purchase').set('Idempotency-Key', k1).send({ ...manualBody, usdcAmount: '0.1', fiatSentTotal: '1.60' });
        const r2 = await request(app).post('/corporate-purchase').set('Idempotency-Key', k2).send({ ...manualBody, usdcAmount: '0.2', fiatSentTotal: '3.20' });
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);

        // The classic float trap: 0.1 + 0.2 === 0.30000000000000004 in binary
        // floats. The exact-decimal pipeline credits precisely 0.3.
        expect(await masterBalance()).toBe('0.30000000');
    });

    test('inexact / negative / exponent money is refused before any economics', async () => {
        const bad = [
            { ...manualBody, usdcAmount: '0.123456789' }, // > 8dp — silently coerced pre-fix
            { ...manualBody, usdcAmount: '1e3' },       // exponent notation
            { ...manualBody, usdcAmount: '-5' },        // negative
        ];
        for (let i = 0; i < bad.length; i++) {
            const res = await request(app)
                .post('/corporate-purchase')
                .set('Idempotency-Key', `r272-bad-${i}-${Date.now()}`)
                .send(bad[i]);
            expect(res.status).toBe(400);
        }
        expect(await prisma.corporatePurchaseLog.count({ where: { adminId: admin.id } })).toBe(0);
        expect(await masterBalance()).toBe('0.00000000');
    });
});
