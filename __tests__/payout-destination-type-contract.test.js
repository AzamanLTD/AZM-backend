// Owner-approved payout destinationType contract (2026-10-27).
//
// Pins, over real PostgreSQL with the real mounted routes:
//   1. The resolver contract itself (pure unit — no DB): every enum value,
//      every ambiguity, every format mismatch, and the two legacy-unambiguous
//      formats that remain callable without a type.
//   2. The wallet withdraw route: ambiguous numeric refuses 400 BEFORE the
//      idempotency claim (same key stays reusable) and BEFORE any debit or
//      Withdrawal row; typed MOMO / BINANCE_PAY_ID dispatch through the SAME
//      resolution the FX gate used.
//   3. The FX gate: typed MOMO demands a fresh rate; typed BINANCE_PAY_ID is
//      same-asset and passes regardless of rate freshness; gate and dispatch
//      refusals are byte-identical (blocker A).
//   4. Saved payout destinations: create REQUIRES a valid, format-consistent
//      type; legacy rows are never mutated on read — they report
//      typeStatus NEEDS_CONFIRMATION with a format-derived suggestion only
//      for unambiguous formats (never a numeric guess).
const request = require('supertest');

// Local regression DBs persist between runs; r42 replay protection refuses a key whose claim belongs to a previous run's user. Keys are unique per run; within the run the same test's retry still reuses ONE key (that is the contract under test).
const RUN_TAG = `dt-${Date.now()}`;
const express = require('express');

const {
    resolvePayoutDestination,
    payoutDestinationRefusal,
    DESTINATION_TYPES,
} = require('../services/payoutDestinationClassification');

// Route-level auth mocks — declared BEFORE any route module is required
// (same pattern as the route-specific FX gate suite).
let mockAuthUserId = null;
jest.mock('../middleware/authMiddleware', () => ({
    protect: function protectGuard(req, res, next) {
        if (mockAuthUserId === null) return res.status(401).json({ success: false, message: 'Not authenticated.' });
        req.user = { id: mockAuthUserId, role: 'USER' };
        next();
    },
    adminOnly: function adminOnlyGuard(_req, _res, next) { next(); },
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: function protectActiveGuard(req, res, next) {
        if (mockAuthUserId === null) return res.status(401).json({ success: false, message: 'Not authenticated.' });
        req.user = req.user || { id: mockAuthUserId, role: 'USER' };
        next();
    },
}));
jest.mock('../middleware/require2FA', () => ({
    require2FA: () => function require2FAGuard(_req, _res, next) { next(); },
}));

const hasDb = (() => {
    try {
        require('fs').accessSync(require.resolve('@prisma/client'));
        return !!process.env.TEST_DATABASE_URL;
    } catch { return false; }
})();

const TRC20 = 'TQ5nRc9eK7mYfP2ZQ9G3eV2XtRrEStQXbW';
const EVM = '0x1234567890abcdef1234567890abcdef12345678';

describe('Payout destinationType contract — resolver (pure unit)', () => {
    test('enum is exactly the approved set', () => {
        expect([...DESTINATION_TYPES].sort()).toEqual(['BEP20', 'BINANCE_PAY_ID', 'ERC20', 'MOMO', 'TRC20']);
    });

    test('numeric destinations are NEVER resolved by digit length without a type', () => {
        for (const n of ['123456789', '0244000000', '0244000000123', '0244000000123456']) {
            const r = resolvePayoutDestination(n, null, null);
            expect(r.status).toBe('AMBIGUOUS');
            expect(payoutDestinationRefusal(r).code).toBe('DESTINATION_TYPE_REQUIRED');
        }
    });

    test('typed MOMO resolves phone numbers of every realistic shape', () => {
        for (const n of ['0244000000', '233244000000', '+233244000000', '024400000012345']) {
            const r = resolvePayoutDestination(n, 'MOMO', null);
            expect(r.status).toBe('RESOLVED');
            expect(r.payoutMethod).toBe('MOMO');
            expect(r.detectedNetwork).toBe('MTN');
        }
        const typed = resolvePayoutDestination('0244000000', 'MOMO', 'AIRTELTIGO');
        expect(typed.detectedNetwork).toBe('AIRTELTIGO');
    });

    test('typed BINANCE_PAY_ID resolves the 8-12 digit window', () => {
        for (const n of ['12345678', '123456789', '123456789012']) {
            const r = resolvePayoutDestination(n, 'BINANCE_PAY_ID', null);
            expect(r.status).toBe('RESOLVED');
            expect(r.payoutMethod).toBe('BINANCE_ID');
        }
        // Outside the provider's ID window: refused as a mismatch.
        const too = resolvePayoutDestination('0244000000123456', 'BINANCE_PAY_ID', null);
        expect(too.status).toBe('MISMATCH');
    });

    test('unambiguous formats remain callable without a type (existing clients)', () => {
        expect(resolvePayoutDestination(TRC20, null, null)).toMatchObject({ status: 'RESOLVED', payoutMethod: 'EXTERNAL_WALLET', detectedNetwork: 'TRC20' });
        expect(resolvePayoutDestination(EVM, null, null)).toMatchObject({ status: 'RESOLVED', payoutMethod: 'EXTERNAL_WALLET', detectedNetwork: 'BEP20' });
        expect(resolvePayoutDestination(EVM, null, 'ERC20')).toMatchObject({ status: 'RESOLVED', detectedNetwork: 'ERC20' });
        expect(resolvePayoutDestination(EVM, 'ERC20', null)).toMatchObject({ status: 'RESOLVED', detectedNetwork: 'ERC20' });
        expect(resolvePayoutDestination(EVM, 'BEP20', null)).toMatchObject({ status: 'RESOLVED', detectedNetwork: 'BEP20' });
    });

    test('format and type contradictions are refused as MISMATCH', () => {
        expect(resolvePayoutDestination('123456789', 'TRC20', null).status).toBe('MISMATCH');
        expect(resolvePayoutDestination('123456789', 'ERC20', null).status).toBe('MISMATCH');
        expect(resolvePayoutDestination(TRC20, 'MOMO', null).status).toBe('MISMATCH');
        expect(resolvePayoutDestination(EVM, 'BINANCE_PAY_ID', null).status).toBe('MISMATCH');
        expect(resolvePayoutDestination('0244000000', 'TRC20', null).status).toBe('MISMATCH');
        expect(payoutDestinationRefusal(resolvePayoutDestination('123456789', 'TRC20', null)).code).toBe('DESTINATION_TYPE_MISMATCH');
    });

    test('unknown formats and unknown enum values are refused distinctly', () => {
        expect(resolvePayoutDestination('hello-world', null, null).status).toBe('UNRECOGNIZED');
        expect(payoutDestinationRefusal(resolvePayoutDestination('hello-world', null, null)).code).toBe('DESTINATION_FORMAT_UNRECOGNIZED');
        const bad = resolvePayoutDestination('123456789', 'BANK', null);
        expect(bad.status).toBe('INVALID_TYPE');
        expect(payoutDestinationRefusal(bad).code).toBe('DESTINATION_TYPE_INVALID');
    });
});

if (hasDb) describe('Payout destinationType contract — route level (real PostgreSQL)', () => {
    let prisma, app, prevAuth;

    const setFreshRate = (rate = 12.5) =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 60_000), lastRateSync: new Date(Date.now() - 60_000) },
            create: { id: 1, liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 60_000), lastRateSync: new Date(Date.now() - 60_000) },
        });

    const setStaleRate = (rate = 12.5) =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 2 * 3600_000), lastRateSync: new Date(Date.now() - 2 * 3600_000) },
            create: { id: 1, liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 2 * 3600_000), lastRateSync: new Date(Date.now() - 2 * 3600_000) },
        });

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('emitBalanceUpdate', async () => {});
        app.use('/api/wallet', require('../routes/walletRoutes'));
        app.use('/api/payout-destinations', require('../routes/payoutDestinationRoutes'));
        app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
    });

    beforeEach(async () => {
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: 50 });
        prevAuth = mockAuthUserId;
        mockAuthUserId = user.id;
    });
    afterEach(() => { mockAuthUserId = prevAuth; });

    test('ambiguous numeric withdraw refuses BEFORE the idempotency claim and any economics', async () => {
        await setFreshRate();
        const user = await prisma.user.findUnique({ where: { id: mockAuthUserId } });
        const before = user.availableBalance.toString();

        const res = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-ambiguous-1`)
            .send({ amount: 5, destination: '0244000000' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DESTINATION_TYPE_REQUIRED');

        // Nothing persisted, no debit.
        expect(await prisma.withdrawal.count({ where: { userId: mockAuthUserId } })).toBe(0);
        const after = await prisma.user.findUnique({ where: { id: mockAuthUserId } });
        expect(after.availableBalance.toString()).toBe(before);

        // The idempotency key was never claimed — a corrected retry with the
        // SAME key executes normally.
        const retry = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-ambiguous-1`)
            .send({ amount: 5, destination: '0244000000', destinationType: 'MOMO' });
        expect(retry.status).toBe(200);
        expect(retry.body.withdrawal.payoutMethod).toBe('MOMO');
    });

    test('the SAME destination string dispatches differently per explicit type', async () => {
        await setFreshRate();
        const momo = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-ten-momo-1`)
            .send({ amount: 5, destination: '1234567890', destinationType: 'MOMO' });
        expect(momo.status).toBe(200);
        expect(momo.body.withdrawal.payoutMethod).toBe('MOMO');
        const binance = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-ten-binance-1`)
            .send({ amount: 5, destination: '1234567890', destinationType: 'BINANCE_PAY_ID' });
        expect(binance.status).toBe(200);
        expect(binance.body.withdrawal.payoutMethod).toBe('BINANCE_ID');
        expect(binance.body.withdrawal.network).toBe('BINANCE_PAY');
    });

    test('gate/dispatch agreement: typed MOMO demands a fresh rate; typed BINANCE passes on stale', async () => {
        await setStaleRate();
        const momo = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-stale-momo-1`)
            .send({ amount: 5, destination: '0244000000', destinationType: 'MOMO' });
        expect(momo.status).toBe(503);
        expect(momo.body.usdcTransactionGate).toBe('CLOSED');
        expect(momo.body.code).toBe('RATE_STALE');

        const binance = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-stale-binance-1`)
            .send({ amount: 5, destination: '123456789', destinationType: 'BINANCE_PAY_ID' });
        expect(binance.status).toBe(200);
        expect(binance.body.usdcTransactionGate).toBeUndefined();

        // Mismatch refusals are byte-identical at gate and dispatch layers:
        // the shared refusal contract (blocker A).
        const gateRefusal = await request(app).post('/api/wallet/withdraw')
            .set('idempotency-key', `${RUN_TAG}-mismatch-gate-1`)
            .send({ amount: 5, destination: '123456789', destinationType: 'TRC20' });
        expect(gateRefusal.status).toBe(400);
        expect(gateRefusal.body).toEqual({ success: false, code: 'DESTINATION_TYPE_MISMATCH', message: payoutDestinationRefusal({ status: 'MISMATCH', destinationType: 'TRC20' }).message });
    });

    test('saved destinations: create REQUIRES a valid, format-consistent type', async () => {
        const missing = await request(app).post('/api/payout-destinations').send({ nickname: 'A', destinationAddress: '0244000000' });
        expect(missing.status).toBe(400);

        const badEnum = await request(app).post('/api/payout-destinations').send({ nickname: 'A', destinationType: 'BANK', destinationAddress: '0244000000' });
        expect(badEnum.status).toBe(400);
        expect(badEnum.body.code).toBe('DESTINATION_TYPE_INVALID');

        const mismatch = await request(app).post('/api/payout-destinations').send({ nickname: 'A', destinationType: 'TRC20', destinationAddress: '0244000000' });
        expect(mismatch.status).toBe(400);
        expect(mismatch.body.code).toBe('DESTINATION_TYPE_MISMATCH');

        const ok = await request(app).post('/api/payout-destinations').send({ nickname: 'Mom', destinationType: 'MOMO', destinationAddress: '0244000000' });
        expect(ok.status).toBe(201);
        expect(ok.body.destination.destinationType).toBe('MOMO');
        expect(ok.body.destination.isDefault).toBe(true);

        const crypto = await request(app).post('/api/payout-destinations').send({ nickname: 'TRX', destinationType: 'TRC20', destinationAddress: TRC20 });
        expect(crypto.status).toBe(201);
    });

    test('legacy saved rows are never mutated — read reports NEEDS_CONFIRMATION with honest suggestions only', async () => {
        // A legacy free-text row (pre-contract) and a numeric row.
        await prisma.payoutDestination.create({
            data: { userId: mockAuthUserId, nickname: 'old binance', destinationType: 'BINANCE_PAY', destinationAddress: '123456789' },
        });
        await prisma.payoutDestination.create({
            data: { userId: mockAuthUserId, nickname: 'old phone', destinationType: 'phone', destinationAddress: '0244000000' },
        });
        // A legacy TRC20 row (unambiguous format, wrong/legacy label).
        await prisma.payoutDestination.create({
            data: { userId: mockAuthUserId, nickname: 'old trc', destinationType: 'crypto', destinationAddress: TRC20 },
        });

        const res = await request(app).get('/api/payout-destinations');
        expect(res.status).toBe(200);
        const byNick = Object.fromEntries(res.body.destinations.map(d => [d.nickname, d]));

        // Numeric legacy rows: NEEDS_CONFIRMATION, never a typed guess.
        expect(byNick['old binance'].typeStatus).toBe('NEEDS_CONFIRMATION');
        expect(byNick['old binance'].suggestedDestinationType).toBeNull();
        expect(byNick['old phone'].typeStatus).toBe('NEEDS_CONFIRMATION');
        expect(byNick['old phone'].suggestedDestinationType).toBeNull();
        // Unambiguous formats get a migration suggestion.
        expect(byNick['old trc'].typeStatus).toBe('NEEDS_CONFIRMATION');
        expect(byNick['old trc'].suggestedDestinationType).toBe('TRC20');
        // Stored values are byte-untouched.
        expect(byNick['old binance'].destinationType).toBe('BINANCE_PAY');
        expect(byNick['old phone'].destinationType).toBe('phone');

        // A contract-valid row reports VALID with no suggestion.
        const ok = await request(app).post('/api/payout-destinations').send({ nickname: 'new momo', destinationType: 'MOMO', destinationAddress: '0244000000' });
        expect(ok.status).toBe(201);
        const res2 = await request(app).get('/api/payout-destinations');
        const fresh = res2.body.destinations.find(d => d.nickname === 'new momo');
        expect(fresh.typeStatus).toBe('VALID');
        expect(fresh.suggestedDestinationType).toBeNull();
    });
});
