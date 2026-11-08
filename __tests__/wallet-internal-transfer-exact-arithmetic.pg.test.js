// __tests__/wallet-internal-transfer-exact-arithmetic.pg.test.js
// =============================================================================
// §r42.2 EXACT MONEY ON POST /api/wallet/internal-transfer
//
// The handler used to run `parseFloat` on the request and hand that DOUBLE to
// Prisma for the balance guard, both balance mutations, the history row and the
// ledger lines. Three defects followed:
//
//   X1. a stated amount with more than 8 decimals was compared UNROUNDED by the
//       guard and then silently rounded by NUMERIC(20,8) on the mutation — the
//       number that was authorised was not the number that moved;
//   X2. float accumulation drifted: ten 0.1 USDC transfers did not leave the
//       pool at exactly 1, and 0.3 - 0.1 - 0.1 did not leave exactly 0.1;
//   X3. values outside 2^53 were mangled at JSON.parse before validation.
//
// This drives the REAL route over real HTTP against real PostgreSQL and asserts
// stored DECIMAL values as exact strings — never toBeCloseTo — so any
// reintroduction of binary money fails.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[wallet-exact-arithmetic] TEST_DATABASE_URL not set — skipping.');

(hasDb ? describe : describe.skip)('wallet internal-transfer — exact decimal arithmetic', () => {
    const http = require('http');
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;
    let server;
    let baseUrl;

    const listen = async (client) => {
        const app = express();
        app.use(express.json());
        app.set('prisma', client);
        app.set('io', null);
        app.set('socketio', null);
        app.set('emitBalanceUpdate', null);
        app.use('/w', require('../routes/walletRoutes'));
        await new Promise((resolve) => { server = app.listen(0, resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    };
    const closeServer = async () => {
        if (server) await new Promise((r) => server.close(r));
        server = null;
    };

    const post = (path, { token, key, body }) => new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(key ? { 'idempotency-key': key } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({
                status: res.statusCode,
                body: data ? JSON.parse(data) : null,
                raw: data,
            }));
        });
        req.on('error', reject);
        req.end(payload);
    });

    const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET);
    const transfer = (user, key, body) => post('/w/internal-transfer', {
        token: tokenFor(user), key: key || randomUUID(), body: { password: TEST_PASSWORD, ...body },
    });

    const balances = async (userId) => {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: { availableBalance: true, vendorUnallocatedBalance: true },
        });
        return {
            available: new Prisma.Decimal(u.availableBalance).toFixed(8),
            pool: new Prisma.Decimal(u.vendorUnallocatedBalance).toFixed(8),
        };
    };

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        await listen(prisma);
    });
    afterAll(async () => {
        await closeServer();
        if (prisma) await prisma.$disconnect();
    });
    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "Ad", "FinancialOperation", '
            + '"LedgerTransaction", "LedgerAccount", "JournalEntry" RESTART IDENTITY CASCADE'
        );
    });

    // ── X2: accumulation drift ─────────────────────────────────────────────
    test('X2. ten 0.1 USDC transfers land on exactly 1.00000000, not 0.9999999999999999', async () => {
        const user = await seedUser(prisma, { availableBalance: 100, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        for (let i = 0; i < 10; i += 1) {
            const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 0.1 });
            expect(res.status).toBe(200);
        }
        const after = await balances(user.id);
        expect(after.pool).toBe('1.00000000');
        expect(after.available).toBe('99.00000000');

        // The posting lines themselves must sum to exactly 1 too — a float
        // handler wrote 0.10000000 ten times but could drift in the totals.
        const lines = await prisma.journalEntry.findMany({
            where: { account: `user:${user.id}:unallocated`, credit: { gt: 0 } },
            select: { credit: true },
        });
        expect(lines).toHaveLength(10);
        const total = lines.reduce((acc, l) => acc.plus(new Prisma.Decimal(l.credit)), new Prisma.Decimal(0));
        expect(total.toFixed(8)).toBe('1.00000000');
    });

    test('X2b. FROM_POOL drains 0.3 exactly to 0.10000000 (no 0.09999999999999998)', async () => {
        const user = await seedUser(prisma, { availableBalance: 0, vendorUnallocatedBalance: 0.3, role: 'VENDOR' });
        for (let i = 0; i < 2; i += 1) {
            const res = await transfer(user, randomUUID(), { direction: 'FROM_POOL', amount: 0.1 });
            expect(res.status).toBe(200);
        }
        const after = await balances(user.id);
        expect(after.pool).toBe('0.10000000');
        expect(after.available).toBe('0.20000000');
    });

    // ── X1: precision the column cannot hold ───────────────────────────────
    test('X1. a 9-dp amount is refused, never rounded after the guard passed', async () => {
        const user = await seedUser(prisma, { availableBalance: 100, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const before = await balances(user.id);
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: '0.000000001' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('USDC_AMOUNT_PRECISION');
        expect(await balances(user.id)).toEqual(before);
        expect(await prisma.transactionHistory.count({
            where: { userId: user.id, type: 'INTERNAL_TRANSFER' },
        })).toBe(0);
    });

    test('X1b. the 8-dp boundary itself is accepted and stored exactly', async () => {
        const user = await seedUser(prisma, { availableBalance: 1, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 0.00000001 });
        expect(res.status).toBe(200);
        expect(res.body.data.amount).toBe(0.00000001);
        const after = await balances(user.id);
        expect(after.pool).toBe('0.00000001');
        expect(after.available).toBe('0.99999999');
    });

    // ── X3: range ──────────────────────────────────────────────────────────
    test('X3. an amount at 10^12 is refused by the parser, not by the column', async () => {
        const user = await seedUser(prisma, { availableBalance: 5, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: '1000000000000' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('USDC_AMOUNT_OUT_OF_RANGE');
    });

    test('X3b. the largest 8-dp value below the cap passes validation (and then fails on funds)', async () => {
        const user = await seedUser(prisma, { availableBalance: 5, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: '999999999999.99999999' });
        expect(res.status).toBe(400);
        // The FUNDS refusal, not a parse refusal: the amount was understood
        // exactly and compared against the real balance.
        expect(res.body.message).toMatch(/Insufficient available balance/);
        expect((await balances(user.id)).available).toBe('5.00000000');
    });

    // ── input hygiene ──────────────────────────────────────────────────────
    test.each([
        ['garbage', 'abc'],
        ['empty string', ''],
        ['zero', 0],
        ['negative', -1],
        ['exponent zero', '0e0'],
        ['NaN string', 'NaN'],
        ['Infinity string', 'Infinity'],
        ['null', null],
    ])('X4. %s is refused with no mutation', async (_label, amount) => {
        const user = await seedUser(prisma, { availableBalance: 10, vendorUnallocatedBalance: 10, role: 'VENDOR' });
        const before = await balances(user.id);
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount });
        expect(res.status).toBe(400);
        expect(await balances(user.id)).toEqual(before);
    });

    test('X4b. a string and a number carrying the same value execute identically', async () => {
        const a = await seedUser(prisma, { availableBalance: 10, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const b = await seedUser(prisma, { availableBalance: 10, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        expect((await transfer(a, randomUUID(), { direction: 'TO_POOL', amount: '0.1' })).status).toBe(200);
        expect((await transfer(b, randomUUID(), { direction: 'TO_POOL', amount: 0.1 })).status).toBe(200);
        expect(await balances(a.id)).toEqual(await balances(b.id));
    });

    // ── §r42.3: string-authoritative input, JSON-number collision ──────────
    test('P1. a decimal string above the double boundary is honoured exactly', async () => {
        const user = await seedUser(prisma, {
            availableBalance: new Prisma.Decimal('100000001'), vendorUnallocatedBalance: 0, role: 'VENDOR',
        });
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: '100000000.00000002' });
        expect(res.status).toBe(200);
        const after = await balances(user.id);
        expect(after.pool).toBe('100000000.00000002');
        expect(after.available).toBe('0.99999998');
    });

    test('P2. the same amount as a JSON number is REFUSED, never rounded', async () => {
        // Proven collision: JSON.parse already moved the last digit before the
        // handler could see it, which is exactly why a number cannot be
        // "converted back" to the value the client sent.
        expect(String(JSON.parse('100000000.00000002'))).toBe('100000000.00000001');

        const user = await seedUser(prisma, {
            availableBalance: new Prisma.Decimal('100000001'), vendorUnallocatedBalance: 0, role: 'VENDOR',
        });
        const before = await balances(user.id);
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 100000000.00000002 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('USDC_AMOUNT_STRING_REQUIRED');
        expect(await balances(user.id)).toEqual(before);
        expect(await prisma.transactionHistory.count({
            where: { userId: user.id, type: 'INTERNAL_TRANSFER' },
        })).toBe(0);
    });

    test('P3. a legacy JSON number still works for the Flutter client (back-compat)', async () => {
        const user = await seedUser(prisma, { availableBalance: 10, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 0.1 });
        expect(res.status).toBe(200);
        expect((await balances(user.id)).pool).toBe('0.10000000');
    });

    test('P4. a fractional JSON number inside the double-fidelity band is exact', async () => {
        const user = await seedUser(prisma, {
            availableBalance: new Prisma.Decimal('30000001'), vendorUnallocatedBalance: 0, role: 'VENDOR',
        });
        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 30000000.12345678 });
        expect(res.status).toBe(200);
        const after = await balances(user.id);
        expect(after.pool).toBe('30000000.12345678');
        expect(after.available).toBe('0.87654322');
    });

    test('P5. a fractional number exactly at 2^25 is refused; a whole number above it is not', async () => {
        const user = await seedUser(prisma, {
            availableBalance: new Prisma.Decimal('100000000'), vendorUnallocatedBalance: 0, role: 'VENDOR',
        });
        const before = await balances(user.id);
        // 2^25 USDC: ulp is now wider than one 8-dp step → must be a string.
        const refused = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 33554432.5 });
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('USDC_AMOUNT_STRING_REQUIRED');
        expect(await balances(user.id)).toEqual(before);

        // A whole number carries no fractional digits to lose, so it stays valid.
        const accepted = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: 90000000 });
        expect(accepted.status).toBe(200);
        expect((await balances(user.id)).pool).toBe('90000000.00000000');
    });

    // ── atomicity of the two movements ─────────────────────────────────────
    test('X5. a mid-transaction failure leaves BOTH balances untouched (no half-move)', async () => {
        const user = await seedUser(prisma, { availableBalance: 50, vendorUnallocatedBalance: 0, role: 'VENDOR' });
        const before = await balances(user.id);

        // Prisma 6 has no $use: a query extension on the SAME client the route
        // uses is the only way to fail inside the interactive transaction.
        const failing = prisma.$extends({
            query: {
                transactionHistory: {
                    async create() {
                        throw new Error('injected mid-transaction failure');
                    },
                },
            },
        });
        await closeServer();
        await listen(failing);

        const res = await transfer(user, randomUUID(), { direction: 'TO_POOL', amount: '0.1' });
        expect(res.status).toBe(500);

        await closeServer();
        await listen(prisma);

        expect(await balances(user.id)).toEqual(before);
        expect(await prisma.transactionHistory.count({
            where: { userId: user.id, type: 'INTERNAL_TRANSFER' },
        })).toBe(0);
        expect(await prisma.ledgerTransaction.count({ where: { userId: user.id } })).toBe(0);
    });
});
