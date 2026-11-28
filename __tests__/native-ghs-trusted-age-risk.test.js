// __tests__/native-ghs-trusted-age-risk.test.js
// =============================================================================
// #392 workstreams 1 and 2 — the RISK GATE at the REAL ROUTES.
//
// W1: the access JWT carries no createdAt, and the gate used to read the age
//     from `req.user`. That made every account look seasoned, so the
//     new-account rule never ran on a production token. The age now comes from
//     the live User row, and a missing/unreadable age refuses (503).
// W2: GHS thresholds are decided in EXACT PESEWAS. A float comparison at a
//     threshold is a coin flip on which side of the line a payout lands.
//
// These are ROUTE tests on purpose: a unit test that hands the gate an
// `accountAgeHours` value would prove nothing about the bypass.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-trusted-age-risk] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    // TEST-ONLY thresholds, string-valued on purpose (exact pesewa parsing).
    // They are NOT approved production values.
    process.env.GHS_RISK_AMOUNT_POLICY = '{"largeGhs":"5000.00","hugeGhs":"20000.00","newAccountMinGhs":"15000.00"}';
    process.env.BANK_PAYOUT_FEE_GHS = '0';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY
        || 'test-only-bank-beneficiary-hmac-key-32bytes';
}

(hasDb ? describe : describe.skip)('trusted account age + exact GHS thresholds (real PostgreSQL, real routes)', () => {
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient, Prisma } = require('@prisma/client');
    const ghsWallet = require('../src/services/nativeGhsWalletService');
    const savedBankBeneficiaryService = require('../src/services/savedBankBeneficiaryService');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;

    const RATE = 12.5;
    const DEST = '233241234567';
    const ACCOUNT = '1234567890123';
    const BANK_CODE = 'GCB';
    const ACCOUNT_NAME = 'Ama Mensah';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    async function setSettings() {
        const data = {
            liveRetailRate: RATE, liveUsdToGhs: RATE, liveRateSource: 'KOTANI_PAY',
            lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: true,
            modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false,
            nativeGhsWithdrawalEnabled: true,
        };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 500000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 500000 },
        });
    }

    function bankPort() {
        const initiate = jest.fn(async () => {
            throw new Error('initiateBankTransfer must not be called by a risk refusal');
        });
        return {
            initiate,
            port: {
                capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }),
                listBanks: async () => ({ stale: false, banks: [{ code: 'GCB', name: 'GCB Bank' }] }),
                validateBankAccount: async ({ bankCode }) => ({
                    valid: true, accountName: ACCOUNT_NAME, bankCode, provider: 'MOOLRE', validatedAt: new Date().toISOString(),
                }),
                initiateBankTransfer: initiate,
            },
        };
    }

    function buildApp(port) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.set('paymentFailoverService', { initiateTransfer: jest.fn() });
        if (port) app.set('moolreBankPayoutPort', port);
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    // THE PRODUCTION TOKEN SHAPE — deliberately WITHOUT createdAt.
    const tokenFor = (user) => jwt.sign(
        { id: user.id, username: user.username || 'risk-user', role: 'USER', tokenVersion: 0, typ: 'access' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);

    const ghsPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', randomUUID())
        .send({ password: TEST_PASSWORD, destination: DEST, network: 'MTN', ...body });
    const bankPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/bank'), user)
        .set('Idempotency-Key', randomUUID())
        .send({ password: TEST_PASSWORD, ...body });

    /** A funded customer with a real createdAt, seeded through the ledger. */
    async function fundedUser({ ageHours = 1, ghs = 100000 } = {}) {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 0 });
        await prisma.$transaction(async (tx) => {
            await ghsWallet.creditNativeGhs({
                tx, userId: user.id, amountGhs: new Prisma.Decimal(ghs).toFixed(2),
                idempotencyKey: `test:seed:ghs:${user.id}`, description: 'test seed GHS',
            });
        });
        await prisma.user.update({
            where: { id: user.id },
            data: { createdAt: new Date(Date.now() - ageHours * 3600 * 1000) },
        });
        const beneficiary = await savedBankBeneficiaryService.createBeneficiary(prisma, user.id, {
            accountNumber: ACCOUNT, bankCode: BANK_CODE, bankName: 'GCB Bank', accountName: ACCOUNT_NAME,
        }, {
            port: {
                capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true }),
                // the save-time enquiry needs a FRESH directory before it will
                // validate anything (a stale list is not evidence)
                listBanks: async () => ({ stale: false, banks: [{ code: 'GCB', name: 'GCB Bank' }] }),
                validateBankAccount: async ({ bankCode }) => ({
                    valid: true, accountName: ACCOUNT_NAME, bankCode, provider: 'MOOLRE', validatedAt: new Date().toISOString(),
                }),
            },
        });
        return { user, beneficiary };
    }

    async function stateOf(userId) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { nativeGhsBalance: true, availableBalance: true },
        });
        const liquidity = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        return {
            nativeGhs: String(user.nativeGhsBalance),
            available: String(user.availableBalance),
            ledgerRows: await prisma.ledgerTransaction.count({ where: { userId } }),
            withdrawals: await prisma.withdrawal.count({ where: { userId } }),
            history: await prisma.transactionHistory.count({ where: { userId } }),
            reservedGhs: String(liquidity.reservedGhs),
            inTransitGhs: String(liquidity.inTransitGhs),
            quotes: Number((await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "TransactionQuote" WHERE "userId" = ${userId}`)[0].n),
        };
    }

    // ── W1: the new-account rule fires on a token with no createdAt ───────────
    test('1: a NEW account above newAccountMinGhs is blocked on MoMo', async () => {
        const { user } = await fundedUser({ ageHours: 1 });
        const before = await stateOf(user.id);
        const res = await ghsPost(buildApp(bankPort().port), user, { amountGhs: '15000.01' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FRAUD_BLOCKED');
        expect(res.body.data.rules).toContain('GHS_NEW_ACCOUNT_LARGE_TX');
        expect(await stateOf(user.id)).toEqual(before);
    });

    test('2: the same NEW account is blocked on BANK, with no provider call', async () => {
        const { user, beneficiary } = await fundedUser({ ageHours: 1 });
        const { port, initiate } = bankPort();
        const before = await stateOf(user.id);
        const res = await bankPost(buildApp(port), user, { amountGhs: '15000.01', beneficiaryId: beneficiary.id });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FRAUD_BLOCKED');
        expect(res.body.data.rules).toContain('GHS_NEW_ACCOUNT_LARGE_TX');
        expect(initiate).not.toHaveBeenCalled();
        expect(await stateOf(user.id)).toEqual(before);
    });

    test('3: an older account is not blocked by age alone', async () => {
        const { user } = await fundedUser({ ageHours: 72 });
        const res = await ghsPost(buildApp(bankPort().port), user, { amountGhs: '15000.01' });
        expect([200, 202]).toContain(res.status);
        if (res.body.data && res.body.data.rules) {
            expect(res.body.data.rules).not.toContain('GHS_NEW_ACCOUNT_LARGE_TX');
        }
    });

    test('4: the age boundary is the rule\'s own semantics (< maxAccountAgeHours)', async () => {
        const maxHours = 24;
        const instant = Date.now();
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(instant);
        try {
            // exactly AT the boundary: not "new" (the rule is strictly less-than)
            const at = await fundedUser({ ageHours: 0 });
            await prisma.user.update({ where: { id: at.user.id }, data: { createdAt: new Date(instant - maxHours * 3600 * 1000) } });
            const atRes = await ghsPost(buildApp(bankPort().port), at.user, { amountGhs: '15000.01' });
            expect([200, 202]).toContain(atRes.status);

            // one minute INSIDE the boundary: new
            const inside = await fundedUser({ ageHours: 0 });
            await prisma.user.update({ where: { id: inside.user.id }, data: { createdAt: new Date(instant - (maxHours - 1 / 60) * 3600 * 1000) } });
            const insideRes = await ghsPost(buildApp(bankPort().port), inside.user, { amountGhs: '15000.01' });
            expect(insideRes.status).toBe(403);
            expect(insideRes.body.data.rules).toContain('GHS_NEW_ACCOUNT_LARGE_TX');

            // one minute OUTSIDE: not new
            const outside = await fundedUser({ ageHours: 0 });
            await prisma.user.update({ where: { id: outside.user.id }, data: { createdAt: new Date(instant - (maxHours + 1 / 60) * 3600 * 1000) } });
            const outsideRes = await ghsPost(buildApp(bankPort().port), outside.user, { amountGhs: '15000.01' });
            expect([200, 202]).toContain(outsideRes.status);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('5: a user row that cannot be found refuses safely (503) before any money moves', async () => {
        const { user } = await fundedUser({ ageHours: 72 });
        const broken = new Proxy(prisma, {
            get(target, prop) {
                if (prop === 'user') {
                    return { ...target.user, findUnique: async () => null };
                }
                return target[prop];
            },
        });
        const app = express();
        app.use(express.json());
        app.set('prisma', broken);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.set('paymentFailoverService', { initiateTransfer: jest.fn() });
        app.set('moolreBankPayoutPort', bankPort().port);
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));

        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '100.00' });
        expect([401, 403, 503]).toContain(res.status);
        expect(await stateOf(user.id)).toEqual(before);
    });

    test('6: a database error during the age read is a typed 503 and moves nothing', async () => {
        const { user } = await fundedUser({ ageHours: 72 });
        const broken = new Proxy(prisma, {
            get(target, prop) {
                if (prop === 'user') {
                    return {
                        ...target.user,
                        findUnique: async (args) => {
                            if (args && args.select && args.select.createdAt) throw new Error('connection reset');
                            return target.user.findUnique(args);
                        },
                    };
                }
                return target[prop];
            },
        });
        const app = express();
        app.use(express.json());
        app.set('prisma', broken);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.set('paymentFailoverService', { initiateTransfer: jest.fn() });
        app.set('moolreBankPayoutPort', bankPort().port);
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));

        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '100.00' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RISK_DATA_UNAVAILABLE');
        expect(await stateOf(user.id)).toEqual(before);
    });

    // ── W2: exact pesewa thresholds on both rails ────────────────────────────
    const assessmentRules = async (userId) => {
        const row = await prisma.fraudAssessment.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
        return row ? JSON.parse(row.triggeredRules || '[]') : [];
    };

    test('7: large threshold — one pesewa below / at / one pesewa above (MoMo)', async () => {
        const { user } = await fundedUser({ ageHours: 72 });
        const app = buildApp(bankPort().port);
        for (const [amount, expected] of [['4999.99', false], ['5000.00', true], ['5000.01', true]]) {
            const res = await ghsPost(app, user, { amountGhs: amount });
            expect([200, 202]).toContain(res.status);
            const rules = await assessmentRules(user.id);
            expect(rules.includes('GHS_LARGE_WITHDRAWAL')).toBe(expected);
        }
    });

    test('8: huge threshold — one pesewa below / at / one pesewa above (MoMo)', async () => {
        const { user } = await fundedUser({ ageHours: 72 });
        const app = buildApp(bankPort().port);
        for (const [amount, blocked] of [['19999.99', false], ['20000.00', true], ['20000.01', true]]) {
            const res = await ghsPost(app, user, { amountGhs: amount });
            if (blocked) {
                expect(res.status).toBe(403);
                expect(res.body.data.rules).toContain('GHS_HUGE_WITHDRAWAL');
            } else {
                expect([200, 202]).toContain(res.status);
            }
        }
    });

    test('9: new-account threshold boundary (rule is strictly greater-than)', async () => {
        const app = buildApp(bankPort().port);
        for (const [amount, blocked] of [['14999.99', false], ['15000.00', false], ['15000.01', true]]) {
            const { user } = await fundedUser({ ageHours: 1 });
            const res = await ghsPost(app, user, { amountGhs: amount });
            if (blocked) {
                expect(res.status).toBe(403);
                expect(res.body.data.rules).toContain('GHS_NEW_ACCOUNT_LARGE_TX');
            } else {
                expect([200, 202]).toContain(res.status);
            }
        }
    });

    test('10: the same exact boundaries hold on the BANK rail', async () => {
        const { user, beneficiary } = await fundedUser({ ageHours: 72 });
        const { port } = bankPort();
        const app = buildApp(port);
        const below = await bankPost(app, user, { amountGhs: '19999.99', beneficiaryId: beneficiary.id });
        expect([200, 202]).toContain(below.status);
        const at = await bankPost(app, user, { amountGhs: '20000.00', beneficiaryId: beneficiary.id });
        expect(at.status).toBe(403);
        expect(at.body.data.rules).toContain('GHS_HUGE_WITHDRAWAL');
    });

    test('11: a GHS amount is never assessed with the USDC thresholds', async () => {
        const { user } = await fundedUser({ ageHours: 72, ghs: 100000 });
        const res = await ghsPost(buildApp(bankPort().port), user, { amountGhs: '6000.00' });
        expect([200, 202]).toContain(res.status);
        const rules = await assessmentRules(user.id);
        expect(rules).toContain('GHS_LARGE_WITHDRAWAL');
        expect(rules).not.toContain('LARGE_WITHDRAWAL');
        expect(rules).not.toContain('HUGE_WITHDRAWAL');
    });

    test('12: a non-pesewa GHS amount is refused before the gate (422), on both rails', async () => {
        const { user, beneficiary } = await fundedUser({ ageHours: 72 });
        const { port, initiate } = bankPort();
        const before = await stateOf(user.id);
        const momo = await ghsPost(buildApp(port), user, { amountGhs: '100.001' });
        expect(momo.status).toBe(422);
        const bank = await bankPost(buildApp(port), user, { amountGhs: '100.001', beneficiaryId: beneficiary.id });
        expect(bank.status).toBe(422);
        expect(initiate).not.toHaveBeenCalled();
        expect(await stateOf(user.id)).toEqual(before);
    });
});
