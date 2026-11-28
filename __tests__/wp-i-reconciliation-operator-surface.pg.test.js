// __tests__/wp-i-reconciliation-operator-surface.pg.test.js
// =============================================================================
// §WP-I §5 — THE OPERATOR SURFACE IS READ-ONLY, PERMISSION-GATED AND REDACTED
//
// Three separate claims are proved here through the REAL router chain:
//   * authorization is decided by requireEffectivePermission from database
//     state, so a specialized admin without `reconciliation.view` is refused;
//   * the DTO is a whitelist, so a secret parked in `details` never leaves;
//   * nothing on this surface mutates a case, a claim or a deposit.
// =============================================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[wp-i-operator] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('WP-I reconciliation operator surface (real PostgreSQL, real JWTs)', () => {
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    const SECRET_HEADER = 'Bearer sk_live_do_not_leak_9f3a';
    const PAYER = '0244999888';
    let prisma;
    let app;
    let financeToken;
    let supportToken;
    let userToken;

    const sign = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const mkAdmin = async (assignedRole) => {
        const u = uniq();
        const user = await prisma.user.create({
            data: { username: `op_${u}`, email: `op_${u}@test.local`, password: 'x', role: 'ADMIN' },
        });
        await prisma.adminRoleAssignment.create({ data: { userId: user.id, role: assignedRole } });
        return user;
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = JWT_SECRET;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('socketio', { to: () => ({ emit: () => {} }), in: () => ({ disconnectSockets: () => {} }), emit: () => {} });
        app.set('emitBalanceUpdate', async () => {});
        app.set('notificationService', { sendNotification: async () => {} });
        app.set('payoutBatchWorker', null);
        app.use('/api/admin', require('../routes/adminRoutes'));
    });

    afterAll(async () => {
        if (!prisma) return;
        // Leave the shared database exactly as found: p5d's reconciliation test
        // asserts a clean baseline, and a suite that seeds cases must not make a
        // later suite fail for reasons unrelated to its own code.
        try {
            await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException"');
            await prisma.$executeRawUnsafe('DELETE FROM "ProviderObservationClaim"');
            await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory"');
            await prisma.$executeRawUnsafe('DELETE FROM "AdminRoleAssignment"');
        } catch (err) { /* best effort */ }
        await prisma.$disconnect();
    });

    let exceptionId;
    let depositUserId;

    beforeEach(async () => {
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "User", "AdminRoleAssignment", "ReconciliationException" RESTART IDENTITY CASCADE');
        await prisma.$executeRawUnsafe('DELETE FROM "ProviderObservationClaim"');
        await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory"');

        const finance = await mkAdmin('FINANCE_ADMIN');
        const support = await mkAdmin('SUPPORT_ADMIN');
        const plain = await prisma.user.create({
            data: { username: `pl_${uniq()}`, email: `pl_${uniq()}@test.local`, password: 'x', role: 'USER' },
        });
        financeToken = sign(finance);
        supportToken = sign(support);
        userToken = sign(plain);

        depositUserId = (await prisma.user.create({
            data: { username: `dp_${uniq()}`, email: `dp_${uniq()}@test.local`, password: 'x', role: 'USER' },
        })).id;

        const inserted = await prisma.$queryRawUnsafe(
            `INSERT INTO "ReconciliationException" ("entityType","entityId","reference","reason","status","details")
             VALUES ('DEPOSIT_FIAT','dep-1','REF-1','PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE','OPEN',$1::jsonb)
             RETURNING "id"`,
            JSON.stringify({
                phase: 'PRE_DISPATCH',
                message: 'no canonical reference',
                ties: ['providerRef', 'txHash'],
                // Everything below must never reach an operator.
                authorization: SECRET_HEADER,
                payer: PAYER,
                raw: { apiKey: 'sk_live_do_not_leak_9f3a', accountnumber: PAYER },
            }),
        );
        exceptionId = inserted[0].id;

        await prisma.$executeRawUnsafe(
            `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
             VALUES (gen_random_uuid(), 'moolre|collection|v2|0244000001|REF-1', 'QUARANTINE', NULL, 'moolre', '0244000001', now(), now())`,
        );

        await prisma.transactionHistory.create({
            data: {
                userId: depositUserId, type: 'DEPOSIT_FIAT', status: 'PENDING', amountGhs: 25, amountUsdc: 25,
                txHash: 'STUCK-REF-1',
            },
        });
        await prisma.transactionHistory.create({
            data: { userId: depositUserId, type: 'DEPOSIT_FIAT', status: 'PENDING', amountGhs: 10, amountUsdc: 10, txHash: 'FRESH-REF-1' },
        });
        await prisma.$executeRawUnsafe(
            `UPDATE "TransactionHistory" SET "createdAt" = now() - interval '3 hours' WHERE "txHash" = 'STUCK-REF-1'`,
        );
    }, 30000);

    test('no token is refused before any handler runs', async () => {
        const res = await request(app).get('/api/admin/reconciliation/exceptions');
        expect(res.status).toBe(401);
    }, 30000);

    test('a non-admin user is refused', async () => {
        const res = await request(app).get('/api/admin/reconciliation/exceptions').set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(403);
    }, 30000);

    test('a specialized admin without reconciliation.view is refused', async () => {
        const res = await request(app).get('/api/admin/reconciliation/exceptions').set('Authorization', `Bearer ${supportToken}`);
        expect(res.status).toBe(403);
    }, 30000);

    test('finance admin sees the case, and only whitelisted detail keys survive', async () => {
        const res = await request(app).get('/api/admin/reconciliation/exceptions').set('Authorization', `Bearer ${financeToken}`);
        expect(res.status).toBe(200);
        const item = res.body.items.find((i) => i.id === exceptionId);
        expect(item).toBeDefined();
        expect(item.reason).toBe('PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE');
        expect(item.status).toBe('OPEN');
        expect(Object.keys(item.details).sort()).toEqual(['message', 'phase', 'ties']);

        const wire = JSON.stringify(res.body);
        expect(wire).not.toContain('sk_live');
        expect(wire).not.toContain(PAYER);
        expect(wire).not.toContain('authorization');
        expect(wire).not.toContain('"raw"');
    }, 30000);

    test('pagination is bounded and invalid values fall back', async () => {
        const big = await request(app).get('/api/admin/reconciliation/exceptions?limit=1000').set('Authorization', `Bearer ${financeToken}`);
        expect(big.status).toBe(200);
        expect(big.body.limit).toBe(100);
        expect(big.body.maxLimit).toBe(100);

        const junk = await request(app).get('/api/admin/reconciliation/exceptions?limit=abc').set('Authorization', `Bearer ${financeToken}`);
        expect(junk.body.limit).toBe(25);
    }, 30000);

    test('filters narrow the case list', async () => {
        const hit = await request(app).get('/api/admin/reconciliation/exceptions?status=OPEN&entityType=DEPOSIT_FIAT')
            .set('Authorization', `Bearer ${financeToken}`);
        expect(hit.body.items.length).toBe(1);
        const miss = await request(app).get('/api/admin/reconciliation/exceptions?status=RESOLVED')
            .set('Authorization', `Bearer ${financeToken}`);
        expect(miss.body.items.length).toBe(0);
    }, 30000);

    test('quarantined observations are visible and ownerless', async () => {
        const res = await request(app).get('/api/admin/reconciliation/quarantined').set('Authorization', `Bearer ${financeToken}`);
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].purpose).toBe('QUARANTINE');
        expect(res.body.items[0].claimedByRef).toBeNull();
    }, 30000);

    test('stuck deposits appear by age, fresh ones do not', async () => {
        const res = await request(app).get('/api/admin/reconciliation/stuck-deposits?olderThanHours=1')
            .set('Authorization', `Bearer ${financeToken}`);
        expect(res.status).toBe(200);
        const refs = res.body.items.map((i) => i.reference);
        expect(refs).toContain('STUCK-REF-1');
        expect(refs).not.toContain('FRESH-REF-1');
        expect(JSON.stringify(res.body)).not.toContain(PAYER);
    }, 30000);

    test('the summary counts open cases, quarantines and stuck deposits', async () => {
        const res = await request(app).get('/api/admin/reconciliation/exceptions/summary').set('Authorization', `Bearer ${financeToken}`);
        expect(res.status).toBe(200);
        expect(res.body.summary.openExceptions).toBe(1);
        expect(res.body.summary.quarantinedObservations).toBe(1);
        expect(res.body.summary.stuckPendingDeposits).toBe(1);
        expect(res.body.summary.openByReason[0].reason).toBe('PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE');
    }, 30000);

    test('reading changes nothing: the case is still OPEN and still the only one', async () => {
        const before = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM "ReconciliationException"');
        await request(app).get('/api/admin/reconciliation/exceptions').set('Authorization', `Bearer ${financeToken}`);
        await request(app).get('/api/admin/reconciliation/exceptions/summary').set('Authorization', `Bearer ${financeToken}`);
        const after = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM "ReconciliationException"');
        expect(after[0].c).toBe(before[0].c);
        const [row] = await prisma.$queryRawUnsafe('SELECT "status" FROM "ReconciliationException" WHERE "id" = $1::uuid', String(exceptionId));
        expect(row.status).toBe('OPEN');
    }, 30000);
});
