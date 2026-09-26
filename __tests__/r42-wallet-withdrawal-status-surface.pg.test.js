'use strict';

// =============================================================================
// §r42 integration wave — wallet-withdrawal STATUS SURFACE (real PostgreSQL).
//
// POST /api/wallet/withdraw (the Flutter "crypto wallet" saved-payout mode)
// creates the Withdrawal queue row and returns accepted; payout workers own
// dispatch afterwards and emit nothing user-facing. This suite pins the
// smallest correct user-facing status surface added for the mobile progress
// experience:
//
//  W1. The owner resolves their own row by PRIMARY KEY — exact field
//      surface, PENDING as accepted, then honest transitions to
//      PROCESSING / COMPLETED / FAILED.
//  W2. A foreign id is indistinguishable from a nonexistent one (404 for
//      both) — no existence oracle across users.
//  W3. Non-numeric / missing ids fail closed with 400.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r42 — wallet-withdrawal status surface (PostgreSQL)', () => {
    let prisma;
    let getWithdrawalStatusById;

    const drive = ({ userId, withdrawalId }) => new Promise((resolve, reject) => {
        const app = { settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; } };
        app.set('prisma', prisma);
        const req = { params: { withdrawalId }, app, get: (k) => app.get(k), user: { id: userId } };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve({ status: this.statusCode, body: b }); return this; },
            setHeader() {},
            end() { resolve({ status: this.statusCode, body: null }); return this; },
        };
        getWithdrawalStatusById(req, res).catch(reject);
    });

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        getWithdrawalStatusById = require('../controllers/walletController').getWithdrawalStatusById;
    });

    afterAll(async () => { await prisma?.$disconnect(); });

    test('W1. owner resolves their own row by primary key; transitions surface honestly', async () => {
        const owner = await seedUser(prisma, { availableBalance: 100 });
        const row = await prisma.withdrawal.create({
            data: {
                userId: owner.id, amount: 25, payoutMethod: 'MOBILE_MONEY',
                network: 'MTN', destination: '0244556677', status: 'PENDING',
            },
        });

        const first = await drive({ userId: owner.id, withdrawalId: String(row.id) });
        expect(first.status).toBe(200);
        expect(first.body.success).toBe(true);
        expect(first.body.withdrawal).toMatchObject({
            id: row.id, status: 'PENDING', amount: 25, destination: '0244556677',
            payoutMethod: 'MOBILE_MONEY', providerTxId: null,
        });
        expect(first.body.withdrawal.createdAt).toEqual(row.createdAt.toISOString());

        // Honest transitions — exactly what the progress sheet renders.
        for (const [status, expectStatus] of [['PROCESSING', 'PROCESSING'], ['COMPLETED', 'COMPLETED'], ['FAILED', 'FAILED']]) {
            await prisma.withdrawal.update({ where: { id: row.id }, data: { status } });
            const seen = await drive({ userId: owner.id, withdrawalId: String(row.id) });
            expect(seen.status).toBe(200);
            expect(seen.body.withdrawal.status).toBe(expectStatus);
        }
    });

    test('W2. foreign id is indistinguishable from a nonexistent one — 404 for both', async () => {
        const owner = await seedUser(prisma, { availableBalance: 100 });
        const stranger = await seedUser(prisma, { availableBalance: 100 });
        const row = await prisma.withdrawal.create({
            data: {
                userId: stranger.id, amount: 10, payoutMethod: 'MOBILE_MONEY',
                network: 'MTN', destination: '0200000000', status: 'PENDING',
            },
        });
        const foreign = await drive({ userId: owner.id, withdrawalId: String(row.id) });
        expect(foreign.status).toBe(404);
        const nonexistent = await drive({ userId: owner.id, withdrawalId: String(row.id + 999999) });
        expect(nonexistent.status).toBe(404);
    });

    test('W3. malformed ids fail closed with 400', async () => {
        const owner = await seedUser(prisma, { availableBalance: 100 });
        expect((await drive({ userId: owner.id, withdrawalId: 'abc' })).status).toBe(400);
        expect((await drive({ userId: owner.id, withdrawalId: '' })).status).toBe(400);
        expect((await drive({ userId: owner.id, withdrawalId: '12; DROP TABLE x' })).status).toBe(400);
    });
});
