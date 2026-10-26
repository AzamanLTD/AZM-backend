// __tests__/deposit-continuation.test.js
// =============================================================================
// Transaction continuation (Backend F) — GET /api/deposit/fiat/status/:id.
// Real PostgreSQL over the mounted route stack with canonical JWTs.
//
// Required cases:
//   - pending deposit is fully re-observable after "session interruption"
//   - completed deposit reports the honest settlement contract: status
//     COMPLETED with settledAt null (no persisted settlement timestamp exists
//     at this head — initiation time is never relabelled as settlement time)
//   - ownership: another user's transaction -> 404 (no existence leak)
//   - unknown id -> honest 404; unauthenticated -> 401
//   - READ-ONLY: repeated calls never mutate the row (status, metadata,
//     balances, providerRef all stable across polls)
//   - non-DEPOSIT_FIAT transactions -> 404 (scope-honest)
//   - payer msisdn is masked in the continuation payload (no raw PII)
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[deposit-continuation.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('Deposit continuation (Backend F)', () => {
    let prisma;
    const seq = { n: 0 };
    const uniq = () => `dc_${Date.now()}_${++seq.n}`;
    const seeded = { users: [], txns: [] };

    let app, request;
    let aliceToken, bobToken, aliceId;
    let tPending, tCompleted, tInternal;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const express = require('express');
        const bcrypt = require('bcryptjs');
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        const { prisma: sharedPrisma } = require('../src/config/baseServices');
        app = express();
        app.use(express.json());
        app.set('prisma', sharedPrisma);
        app.use('/api', require('../middleware/responseHelpers'));
        app.use('/api', require('../src/middleware/prismaInjector'));
        app.use('/api/deposit', require('../routes/depositRoutes'));
        request = require('supertest');

        const { signAccessToken } = require('../services/authTokenService');
        async function makeUser(name) {
            const username = `${name}_${uniq()}`;
            const u = await prisma.user.create({
                data: {
                    username,
                    email: `${username}@azaman.test`,
                    password: await bcrypt.hash('Str0ng!Pass#2026', 10),
                    availableBalance: 0, escrowLockedBalance: 0,
                    disputeEscrowBalance: 0, azamanId: `AZM-${uniq()}`,
                },
            });
            seeded.users.push(u.id);
            return { id: u.id, token: signAccessToken(u) };
        }
        const alice = await makeUser('alice');
        aliceId = alice.id; aliceToken = alice.token;
        bobToken = (await makeUser('bob')).token;

        async function seedDeposit(userId, status, extra = {}) {
            const t = await prisma.transactionHistory.create({
                data: {
                    userId,
                    type: 'DEPOSIT_FIAT',
                    amountUsdc: '12.340000000000',
                    status,
                    providerRef: `ref_${uniq()}`,
                    payerMsisdn: '233201234567',
                    initiatedByUserId: userId,
                    metadata: {
                        provider: 'MTN', network: 'MTN_MOMO',
                        amountGhs: 200, amountGhsExact: '200.00',
                        quoteId: `q_${uniq()}`,
                        quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                        rateAtInitiation: 15.2,
                        payerPhone: '233201234567',
                        ...extra,
                    },
                },
            });
            seeded.txns.push(t.id);
            return t;
        }
        tPending = await seedDeposit(aliceId, 'PENDING');
        tCompleted = await seedDeposit(aliceId, 'COMPLETED');
        tInternal = await prisma.transactionHistory.create({
            data: {
                userId: aliceId, type: 'INTERNAL_TRANSFER',
                amountUsdc: '5.000000000000', status: 'COMPLETED',
            },
        });
        seeded.txns.push(tInternal.id);
    });

    afterAll(async () => {
        await prisma.transactionHistory.deleteMany({ where: { id: { in: seeded.txns } } });
        for (const uid of seeded.users.slice().reverse()) {
            await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        }
        await prisma.$disconnect();
        const { prisma: shared } = require('../src/config/baseServices');
        await shared.$disconnect().catch(() => {});
    });

    const asAlice = (r) => r.set('Authorization', `Bearer ${aliceToken}`);
    const asBob = (r) => r.set('Authorization', `Bearer ${bobToken}`);
    const url = (id) => `/api/deposit/fiat/status/${id}`;

    test('unauthenticated -> 401 at the route boundary', async () => {
        expect((await request(app).get(url(tPending.id))).statusCode).toBe(401);
    });

    test('pending deposit is fully re-observable after session interruption', async () => {
        const res = await asAlice(request(app).get(url(tPending.id)));
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.transaction).toMatchObject({
            id: tPending.id, type: 'DEPOSIT_FIAT', status: 'PENDING',
        });
        expect(res.body.transaction.settledAt).toBeNull();
        // Continuation payload carries the persisted initiation data.
        const c = res.body.continuation;
        expect(c.provider).toBe('MTN');
        expect(c.network).toBe('MTN_MOMO');
        expect(c.amountGhs).toBe(200);
        expect(c.quoteId).toBeTruthy();
        expect(c.quoteExpiresAt).toBeTruthy();
        expect(c.providerRef).toBe(tPending.providerRef);
        // payer PII is masked, never raw.
        expect(c.payerPhoneMasked).toBe('233****567');
        expect(JSON.stringify(res.body)).not.toContain('233201234567');
    });

    test('completed deposit reports honest settlement state', async () => {
        const res = await asAlice(request(app).get(url(tCompleted.id)));
        expect(res.statusCode).toBe(200);
        expect(res.body.transaction.status).toBe('COMPLETED');
        // settledAt is null even for COMPLETED: the schema has no persisted
        // settlement timestamp. createdAt (initiation) must never be
        // relabelled as settlement time. Pinned here so the contract is
        // explicit: null until a real settlement time is recorded at the
        // provider-reconciliation transition.
        expect(res.body.transaction.settledAt).toBeNull();
        expect(res.body.transaction.createdAt).toBeTruthy(); // initiation time, separately reported
    });

    test('ownership: another user transaction and unknown ids -> 404', async () => {
        expect((await asBob(request(app).get(url(tPending.id)))).statusCode).toBe(404);
        expect((await asAlice(request(app).get(url('no-such-id')))).statusCode).toBe(404);
    });

    test('scope-honest: non-DEPOSIT_FIAT transactions are not deposit status', async () => {
        const res = await asAlice(request(app).get(url(tInternal.id)));
        expect(res.statusCode).toBe(404);
    });

    test('READ-ONLY: repeated polls never mutate the record', async () => {
        const before = await prisma.transactionHistory.findUnique({ where: { id: tPending.id } });
        for (let i = 0; i < 3; i += 1) {
            await asAlice(request(app).get(url(tPending.id)));
        }
        const after = await prisma.transactionHistory.findUnique({ where: { id: tPending.id } });
        expect(after.status).toBe(before.status);
        expect(after.metadata).toEqual(before.metadata);
        expect(after.providerRef).toBe(before.providerRef);
        const user = await prisma.user.findUnique({ where: { id: aliceId } });
        expect(Number(user.availableBalance)).toBe(0); // no side effects
    });

    test('history polling stays the authoritative fallback (PENDING visible in list)', async () => {
        // The broad ledger route (GET /api/finance/transactions?status=PENDING)
        // remains the general recovery surface; asserted at the DB contract
        // level here (its route handler applies the same filter shape).
        const rows = await prisma.transactionHistory.findMany({
            where: { userId: aliceId, status: 'PENDING', type: 'DEPOSIT_FIAT' },
            orderBy: { createdAt: 'desc' },
        });
        expect(rows.map(r => r.id)).toContain(tPending.id);
    });
});
