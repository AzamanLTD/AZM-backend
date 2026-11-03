// __tests__/native-ghs-risk-gating.test.js
// =============================================================================
// Issue #389 P0-1: ONE risk gate, wired to the REAL contract, on BOTH rails.
//
// The old code called fraudService.evaluate() with `action: 'WITHDRAWAL_GHS'` and
// read `fraud.blocked`. The engine keys every rule off `tx.type` and answers
// `allowed`, so no rule ran, no answer was read, and an evaluation error was
// logged and ignored. The BANK route had no gate at all. Meanwhile the fiat
// batch worker measured native-GHS rows with `Number(withdrawal.amount)`, which
// is the zero-valued USDC mirror — a large GHS payout looked like a $0 one.
//
// PROVES:
//   1. Velocity counts BOTH stored withdrawal types (WITHDRAWAL + WITHDRAWAL_FIAT).
//   2. A BLOCK decision refuses a MoMo payout before anything moves.
//   3. A BLOCK decision refuses a BANK payout, with no provider call.
//   4. An unavailable risk service refuses with 503 — it is not permission to pay.
//   5. A GHS amount is never compared with the USDC thresholds, and a configured
//      GHS policy is honoured.
//   6. The worker never measures a native-GHS row with the USDC auto-approve
//      limit, and never treats a zero amount as a zero-value payout.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-risk-gating] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    // §P0 the gate REFUSES while no complete GHS amount policy exists, so the
    // happy-path tests in this suite configure one explicitly. The numbers sit
    // far above every fixture amount so only the tests that WANT an amount rule
    // to fire override them.
    process.env.GHS_RISK_AMOUNT_POLICY = '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

(hasDb ? describe : describe.skip)('native-GHS risk gating (real PostgreSQL)', () => {
    // The GHS amount policy is required for a payout to be allowed, so every
    // test starts from a valid one; the tests about a missing, partial or
    // malformed policy override it deliberately.
    const SUITE_POLICY = '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
    beforeEach(() => { process.env.GHS_RISK_AMOUNT_POLICY = SUITE_POLICY; });
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient } = require('@prisma/client');
    const fraudService = require('../services/fraudDetectionService');
    const PayoutBatchWorker = require('../workers/payoutBatchWorker');
    // processNow() early-exits when nothing is selected and nests row detail
    // under `details` when it runs. Read either shape.
    const detailOf = (r) => (r && r.details) || r || {};

    let prisma;
    let seedUser;
    let TEST_PASSWORD;
    let svc;
    let beneficiaries;

    const RATE = 12.5;
    const DEST = '233241234567';
    const ACCOUNT = '1234567890';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        svc = require('../src/services/nativeGhsWithdrawalService');
        beneficiaries = require('../src/services/savedBankBeneficiaryService');
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    beforeEach(() => {
        jest.restoreAllMocks();
        // Reset to a VALID policy: the payout gate refuses without one, so a test
        // that unsets it must not leak that state into the next test.
        process.env.GHS_RISK_AMOUNT_POLICY = SUITE_POLICY;
    });

    async function setSettings(extra = {}) {
        const data = {
            liveRetailRate: RATE, liveUsdToGhs: RATE, liveRateSource: 'KOTANI_PAY',
            lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: true,
            modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false,
            nativeGhsWithdrawalEnabled: true,
            autoPayoutEnabled: true, autoPayoutMaxAmountUsdc: 200,
            ...extra,
        };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 500000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 500000 },
        });
    }

    function providerFakes() {
        const calls = { initiateTransfer: 0, initiateBankTransfer: 0 };
        const dispatcher = {
            initiateTransfer: jest.fn(async () => { calls.initiateTransfer += 1; return { success: true, transactionId: 'MOO-RISK-1' }; }),
        };
        const bankPort = {
            listBanks: jest.fn(async () => ({ stale: false, banks: [{ code: 'GCB', name: 'GCB Bank' }] })),
            validateBankAccount: jest.fn(async ({ accountNumber, bankCode }) => ({
                valid: true, accountName: 'AMA MENSAH', bankCode, validatedAt: new Date().toISOString(),
            })),
            capabilities: () => ({ canInitiateBankPayout: true, mode: 'sandbox' }),
            initiateBankTransfer: jest.fn(async () => { calls.initiateBankTransfer += 1; return { status: 'PENDING', externalId: 'ext-risk-1', providerRef: 'MUL-RISK-1' }; }),
            capabilities: () => ({ canInitiateBankPayout: true, mode: 'sandbox' }),
            getBankTransferStatus: jest.fn(async () => ({ status: 'PENDING' })),
        };
        return { dispatcher, bankPort, calls };
    }

    function buildApp({ dispatcher, bankPort }) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        if (dispatcher) app.set('paymentFailoverService', dispatcher);
        if (bankPort) app.set('moolreBankPayoutPort', bankPort);
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);
    const ghsPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, destination: DEST, network: 'MTN', ...body });
    const bankPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/bank'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, ...body });

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
            reservedGhs: String(liquidity.reservedGhs),
            inTransitGhs: String(liquidity.inTransitGhs),
        };
    }

    async function verifiedBeneficiary(userId) {
        const { bankPort } = providerFakes();
        const created = await beneficiaries.createBeneficiary(prisma, userId, {
            bankCode: 'GCB', bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: 'Ama Mensah', isPrimary: true,
        }, { port: bankPort });
        return created;
    }

    // ── 1. velocity across BOTH stored withdrawal types ─────────────────────
    test('1: velocity counts WITHDRAWAL and WITHDRAWAL_FIAT together', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 500 });
        const app = buildApp(providerFakes());
        // 3 older-type fiat rows + 2 native-GHS rows = 5 in the 60s window.
        for (const type of ['WITHDRAWAL_FIAT', 'WITHDRAWAL_CRYPTO', 'WITHDRAWAL_FIAT', 'WITHDRAWAL_FIAT', 'WITHDRAWAL_FIAT']) {
            await prisma.transactionHistory.create({
                data: { userId: user.id, txHash: `risk-vel-${randomUUID()}`, type, amountUsdc: 0, status: 'PENDING' },
            });
        }
        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '50.00' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FRAUD_BLOCKED');
        expect(res.body.data.rules).toContain('WITHDRAWAL_VELOCITY');
        expect(await stateOf(user.id)).toEqual(before);
    });

    // ── 2. MoMo BLOCK decision ──────────────────────────────────────────────
    test('2: a BLOCK decision refuses the MoMo payout before anything moves', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 300 });
        const { dispatcher, calls } = providerFakes();
        const app = buildApp({ dispatcher });
        jest.spyOn(fraudService, 'evaluate').mockResolvedValue({
            allowed: false, riskScore: 60,
            triggeredRules: [{ id: 'HUGE_WITHDRAWAL', severity: 'BLOCK', description: 'blocked' }],
            asset: 'GHS', amountPolicy: 'APPLIED', policyGaps: [],
        });
        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '50.00' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FRAUD_BLOCKED');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateTransfer).toBe(0);
    });

    // ── 3. BANK BLOCK decision ──────────────────────────────────────────────
    test('3: a BLOCK decision refuses the BANK payout, no provider call', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 300 });
        const beneficiary = await verifiedBeneficiary(user.id);
        const { bankPort, calls } = providerFakes();
        const app = buildApp({ bankPort });
        jest.spyOn(fraudService, 'evaluate').mockResolvedValue({
            allowed: false, riskScore: 60,
            triggeredRules: [{ id: 'WITHDRAWAL_VELOCITY', severity: 'BLOCK', description: 'blocked' }],
            asset: 'GHS', amountPolicy: 'APPLIED', policyGaps: [],
        });
        const before = await stateOf(user.id);
        const res = await bankPost(app, user, { amountGhs: '50.00', beneficiaryId: beneficiary.id });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FRAUD_BLOCKED');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateBankTransfer).toBe(0);
        expect(bankPort.initiateBankTransfer).not.toHaveBeenCalled();
    });

    // ── 4. service unavailable must refuse, not continue ────────────────────
    test('4: an unavailable risk service refuses with 503 and moves nothing', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 300 });
        const { dispatcher, calls } = providerFakes();
        const app = buildApp({ dispatcher });
        jest.spyOn(fraudService, 'evaluate').mockRejectedValue(new Error('fraud db unreachable'));
        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '50.00' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RISK_SERVICE_UNAVAILABLE');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateTransfer).toBe(0);
    });

    test('4b: the BANK rail also refuses when the risk service is unavailable', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 300 });
        const beneficiary = await verifiedBeneficiary(user.id);
        const { bankPort, calls } = providerFakes();
        const app = buildApp({ bankPort });
        jest.spyOn(fraudService, 'evaluate').mockRejectedValue(new Error('timeout'));
        const before = await stateOf(user.id);
        const res = await bankPost(app, user, { amountGhs: '50.00', beneficiaryId: beneficiary.id });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RISK_SERVICE_UNAVAILABLE');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateBankTransfer).toBe(0);
    });

    // ── 5. GHS amounts are not USDC amounts ────────────────────────────────
    test('5: a GHS amount is never judged by the USDC thresholds, and an unset policy refuses', async () => {
        await setSettings();
        delete process.env.GHS_RISK_AMOUNT_POLICY;
        // 12,000 GHS would be "huge" if someone compared it to the USDC $10,000
        // rule, and it must never be judged by that rule. The engine says the
        // amount dimension was NOT evaluated; the gate turns that gap into a
        // refusal. "Nobody configured this" is not "the check passed".
        const direct = await fraudService.evaluate({
            userId: 999999, type: 'WITHDRAWAL', asset: 'GHS', amount: 12000,
            velocityTypes: ['WITHDRAWAL_FIAT', 'WITHDRAWAL_CRYPTO'],
        });
        expect(direct.amountPolicy).toBe('NOT_CONFIGURED');
        expect(direct.policyGaps).toContain('GHS_AMOUNT_POLICY_MISSING');
        expect(direct.policyGaps).not.toContain('GHS_AMOUNT_THRESHOLD_UNCONFIGURED');
        expect(direct.triggeredRules.map((r) => r.id)).not.toContain('HUGE_WITHDRAWAL');
        expect(direct.triggeredRules.map((r) => r.id)).not.toContain('GHS_HUGE_WITHDRAWAL');

        const user = await seedUser(prisma, { nativeGhsBalance: 20000 });
        const { dispatcher, calls } = providerFakes();
        const app = buildApp({ dispatcher });
        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '12000.00' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RISK_POLICY_UNCONFIGURED');
        expect(res.body.data.policyGaps).toContain('GHS_AMOUNT_POLICY_MISSING');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateTransfer).toBe(0);

        // And USDC behaviour is unchanged: the same number IS huge in USDC, and
        // an absent GHS policy is irrelevant to a USDC decision.
        const usdc = await fraudService.evaluate({ userId: 999999, type: 'WITHDRAWAL', asset: 'USDC', amount: 12000 });
        expect(usdc.allowed).toBe(false);
        expect(usdc.triggeredRules.map((r) => r.id)).toContain('HUGE_WITHDRAWAL');
        expect(usdc.policyGaps).toEqual([]);
    });

    test('5b: a configured GHS policy is honoured, and a huge GHS payout is blocked', async () => {
        process.env.GHS_RISK_AMOUNT_POLICY = JSON.stringify({ largeGhs: 2000, hugeGhs: 5000, newAccountMinGhs: 1000 });
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20000 });
        const { dispatcher, calls } = providerFakes();
        const app = buildApp({ dispatcher });
        const res = await ghsPost(app, user, { amountGhs: '6000.00' });
        expect(res.status).toBe(403);
        expect(res.body.data.rules).toContain('GHS_HUGE_WITHDRAWAL');
        expect(calls.initiateTransfer).toBe(0);
    });

    test('5c: a malformed GHS policy fails closed', async () => {
        process.env.GHS_RISK_AMOUNT_POLICY = '{not-json';
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 300 });
        const { dispatcher, calls } = providerFakes();
        const app = buildApp({ dispatcher });
        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '50.00' });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RISK_POLICY_INVALID');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateTransfer).toBe(0);
    });

    // ── 6. worker: zero mirror amount is not a zero-value payout ───────────
    test('6: the worker never measures a native-GHS row with the USDC limit', async () => {
        await setSettings({ autoPayoutMaxAmountUsdc: 200 });
        const user = await seedUser(prisma, { nativeGhsBalance: 100 });
        const txHash = randomUUID();
        await prisma.transactionHistory.create({
            data: { userId: user.id, txHash, type: 'WITHDRAWAL_FIAT', amountUsdc: 0, status: 'PENDING' },
        });
        const ghsRow = await prisma.$queryRawUnsafe(
            'INSERT INTO "Withdrawal" ("userId","amount","amountGhs","settlementCurrency","payoutMethod","network","destination","status","transactionHistoryId","createdAt","updatedAt") ' +
            'VALUES ($1, 0, 5000, \'GHS_NATIVE\', \'MOMO\', \'MTN\', $2, \'PENDING\', (SELECT id FROM "TransactionHistory" WHERE "txHash" = $3), now(), now()) RETURNING "id"',
            user.id, DEST, txHash
        );
        const ghsId = ghsRow[0].id;
        const { dispatcher, calls } = providerFakes();
        const worker = new PayoutBatchWorker(prisma, { emit: () => {} }, dispatcher, null);
        const results = await worker.processNow({ force: true });

        // Not selected, not auto-approved, not dispatched as a fiat payout.
        // (An empty selection returns the early-exit shape with processed: 0.)
        expect([].concat(detailOf(results).processed || [])).toEqual([]);
        expect(calls.initiateTransfer).toBe(0);
        const after = await prisma.withdrawal.findUnique({ where: { id: ghsId }, select: { status: true, amount: true, amountGhs: true } });
        expect(after.status).toBe('PENDING');
        expect(String(after.amount)).toBe('0');
        expect(String(after.amountGhs)).toBe('5000');
    });

    test('6b: a zero-amount fiat row is parked, never auto-approved', async () => {
        await setSettings({ autoPayoutMaxAmountUsdc: 200 });
        const user = await seedUser(prisma, { nativeGhsBalance: 0 });
        const txHash = randomUUID();
        await prisma.transactionHistory.create({
            data: { userId: user.id, txHash, type: 'WITHDRAWAL_FIAT', amountUsdc: 0, status: 'PENDING' },
        });
        const row = await prisma.$queryRawUnsafe(
            'INSERT INTO "Withdrawal" ("userId","amount","settlementCurrency","payoutMethod","destination","status","transactionHistoryId","createdAt","updatedAt") ' +
            'VALUES ($1, 0, \'USDC\', \'MOBILE_MONEY\', $2, \'PENDING\', (SELECT id FROM "TransactionHistory" WHERE "txHash" = $3), now(), now()) RETURNING "id"',
            user.id, DEST, txHash
        );
        const { dispatcher, calls } = providerFakes();
        const worker = new PayoutBatchWorker(prisma, { emit: () => {} }, dispatcher, null);
        const results = await worker.processNow({ force: true });
        expect((detailOf(results).flaggedManualReview || []).map((r) => r.reason)).toContain('ZERO_AMOUNT_NOT_AUTO_APPROVABLE');
        expect(calls.initiateTransfer).toBe(0);
        const after = await prisma.withdrawal.findUnique({ where: { id: row[0].id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_MANUAL_REVIEW');
    });
});
