// __tests__/native-ghs-risk-hardening.test.js
// =============================================================================
// Issue #389 hardening: the parts of the risk gate and the payee API that could
// still fail OPEN.
//
// PROVES
//   §P0-1a  a risk-service READ failure refuses the payout (503) and moves
//           nothing — "the database was down" is not "the customer is safe".
//   §P0-1b  the GHS amount policy has an explicit lifecycle: missing, partial,
//           mis-ordered and malformed are four different refusals, boundaries
//           are inclusive and exact, and the USDC thresholds are never applied
//           to a GHS amount on either rail.
//   §P0-1c  a persisted assessment names its ASSET; a GHS amount never lands in
//           the USDC column.
//   §P0-4   the BANK rail is capability-gated at BOTH entry points: a port that
//           cannot prove it can pay out is refused before any mutation.
//   §P1C    bank directory / update / revalidate: leading zeroes survive, the
//           destination is immutable, revalidation binds to the STORED account.
//   §P1-6   one account-length contract at both layers, boundaries exact.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-risk-hardening] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
}

(hasDb ? describe : describe.skip)('native-GHS risk + payee hardening (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient } = require('@prisma/client');
    const fraudService = require('../services/fraudDetectionService');
    const schemas = require('../services/validation/financialSchemas');

    const POLICY = '{"largeGhs":2000,"hugeGhs":5000,"newAccountMinGhs":1000}';

    let prisma;
    let seedUser;
    let TEST_PASSWORD;
    let beneficiaries;
    let controller;

    const RATE = 12.5;
    const DEST = '233241234567';
    const ACCOUNT = '0123456789'; // deliberately leading-zero: digits are opaque
    const BIG = 1_000_000; // far above every fixture amount, for happy paths

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        beneficiaries = require('../src/services/savedBankBeneficiaryService');
        controller = require('../controllers/bankBeneficiaryController');
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    beforeEach(() => { process.env.GHS_RISK_AMOUNT_POLICY = POLICY; });
    afterEach(() => { jest.restoreAllMocks(); });

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

    function bankPort({ canInitiate = true } = {}) {
        const calls = { initiateBankTransfer: 0, validateBankAccount: 0, listBanks: 0 };
        const port = {
            listBanks: jest.fn(async () => {
                calls.listBanks += 1;
                return { stale: false, banks: [
                    { code: 'GCB', name: 'GCB Bank' },
                    { code: '030100', name: 'Leading Zero Bank' },
                ] };
            }),
            validateBankAccount: jest.fn(async ({ accountNumber, bankCode }) => {
                calls.validateBankAccount += 1;
                return { valid: true, accountName: 'AMA MENSAH', bankCode, validatedAt: new Date().toISOString() };
            }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: jest.fn(async () => { calls.initiateBankTransfer += 1; return { status: 'PENDING', externalId: 'ext-h1', providerRef: 'MUL-H1' }; }),
            capabilities: () => ({ canInitiateBankPayout: canInitiate, canValidateBankAccount: true, mode: 'sandbox' }),
            getBankTransferStatus: jest.fn(async () => ({ status: 'PENDING' })),
        };
        return { port, calls };
    }

    function buildApp({ port, db } = {}) {
        const app = express();
        app.use(express.json());
        app.set('prisma', db || prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.set('paymentFailoverService', { initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-H1' })) });
        if (port) app.set('moolreBankPayoutPort', port);
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        app.use('/api/bank-beneficiaries', require('../routes/bankBeneficiaryRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);
    const ghsPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, destination: DEST, network: 'MTN', ...body });
    const bankPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/bank'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, ...body });
    const bankQuote = (app, user, body = {}) => auth(request(app).post('/api/withdraw/bank/quote'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, ...body });

    async function stateOf(userId) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { nativeGhsBalance: true, availableBalance: true } });
        const liquidity = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        return {
            nativeGhs: String(user.nativeGhsBalance),
            available: String(user.availableBalance),
            ledgerRows: await prisma.ledgerTransaction.count({ where: { userId } }),
            withdrawals: await prisma.withdrawal.count({ where: { userId } }),
            quotes: Number((await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "TransactionQuote" WHERE "userId" = ${userId}`)[0].n),
            reservedGhs: String(liquidity.reservedGhs),
            inTransitGhs: String(liquidity.inTransitGhs),
        };
    }

    async function verifiedBeneficiary(userId, overrides = {}) {
        const { port } = bankPort();
        const created = await beneficiaries.createBeneficiary(prisma, userId, {
            bankCode: 'GCB', bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: 'Ama Mensah', ...overrides,
        }, { port });
        return created;
    }

    // ── §P0-1a a READ failure is not a pass ─────────────────────────────────
    test('a risk-service read failure refuses BOTH rails and moves nothing', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 5000 });
        const bank = await verifiedBeneficiary(user.id);
        // The velocity read fails. In FAIL_CLOSED mode that is a refusal, not a
        // zero count: an unreachable risk database says nothing about the payer.
        const broken = new Proxy(prisma, {
            get(target, prop, recv) {
                if (prop === 'transactionHistory') {
                    return new Proxy({}, { get: () => () => Promise.reject(new Error('risk db down')) });
                }
                return Reflect.get(target, prop, recv);
            },
        });
        const { port, calls } = bankPort();
        const app = buildApp({ port, db: broken });

        const before = await stateOf(user.id);
        const momo = await ghsPost(app, user, { amountGhs: '50.00' });
        expect(momo.status).toBe(503);
        expect(momo.body.code).toBe('RISK_DATA_UNAVAILABLE');
        const bankRes = await bankPost(app, user, { amountGhs: '50.00', beneficiaryId: bank.id });
        expect(bankRes.status).toBe(503);
        expect(bankRes.body.code).toBe('RISK_DATA_UNAVAILABLE');
        expect(await stateOf(user.id)).toEqual(before);
        expect(calls.initiateBankTransfer).toBe(0);
    });

    // ── §P0-1b the policy lifecycle ─────────────────────────────────────────
    describe('GHS amount policy lifecycle', () => {
        const evaluate = (amount) => fraudService.evaluate({
            userId: 999999, type: 'WITHDRAWAL', asset: 'GHS', amount,
            velocityTypes: ['WITHDRAWAL_FIAT'], riskDataMode: 'FAIL_CLOSED',
        });

        test('missing, partial and malformed are three DISTINCT refusals', async () => {
            delete process.env.GHS_RISK_AMOUNT_POLICY;
            const missing = await evaluate(50);
            expect(missing.policyGaps).toEqual(['GHS_AMOUNT_POLICY_MISSING']);

            process.env.GHS_RISK_AMOUNT_POLICY = '{"largeGhs":2000}';
            const partial = await evaluate(50);
            expect(partial.policyGaps).toContain('GHS_AMOUNT_POLICY_INCOMPLETE');
            expect(partial.policyGaps).not.toContain('GHS_AMOUNT_POLICY_MISSING');
            expect(partial.amountPolicy).toBe('NOT_CONFIGURED');

            process.env.GHS_RISK_AMOUNT_POLICY = '{not-json';
            await expect(evaluate(50)).rejects.toMatchObject({ code: 'RISK_POLICY_INVALID' });

            // mis-ordered thresholds are a footgun, not a policy
            process.env.GHS_RISK_AMOUNT_POLICY = '{"largeGhs":5000,"hugeGhs":2000,"newAccountMinGhs":100}';
            await expect(evaluate(50)).rejects.toMatchObject({ code: 'RISK_POLICY_INVALID' });
        });

        test('boundaries are inclusive and exact, and never USDC', async () => {
            // largeGhs 2000 / hugeGhs 5000: 1999.99 is neither, 2000.00 is large,
            // 5000.01 is huge. Equality is a rule trigger, not a rounding grey zone.
            const below = await evaluate('1999.99');
            expect(below.triggeredRules.map((r) => r.id)).not.toContain('GHS_LARGE_WITHDRAWAL');
            const atLarge = await evaluate('2000.00');
            expect(atLarge.triggeredRules.map((r) => r.id)).toContain('GHS_LARGE_WITHDRAWAL');
            expect(atLarge.triggeredRules.map((r) => r.id)).not.toContain('GHS_HUGE_WITHDRAWAL');
            const atHuge = await evaluate('5000.01');
            expect(atHuge.triggeredRules.map((r) => r.id)).toContain('GHS_HUGE_WITHDRAWAL');
            // The USDC rules are unreachable for a GHS amount at ANY size.
            const enormous = await evaluate(500000);
            const ids = enormous.triggeredRules.map((r) => r.id);
            expect(ids).not.toContain('LARGE_WITHDRAWAL');
            expect(ids).not.toContain('HUGE_WITHDRAWAL');
            expect(ids).not.toContain('NEW_ACCOUNT_LARGE_TX');
        });

        test('an unset policy refuses the BANK rail too, before any mutation', async () => {
            await setSettings();
            delete process.env.GHS_RISK_AMOUNT_POLICY;
            const user = await seedUser(prisma, { nativeGhsBalance: 5000 });
            const bank = await verifiedBeneficiary(user.id);
            const { port, calls } = bankPort();
            const app = buildApp({ port });
            const before = await stateOf(user.id);
            const res = await bankPost(app, user, { amountGhs: '50.00', beneficiaryId: bank.id });
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('RISK_POLICY_UNCONFIGURED');
            expect(res.body.data.policyGaps).toContain('GHS_AMOUNT_POLICY_MISSING');
            expect(await stateOf(user.id)).toEqual(before);
            expect(calls.initiateBankTransfer).toBe(0);
            expect(calls.validateBankAccount).toBe(0);
        });
    });

    // ── §P0-1c an assessment names its asset ────────────────────────────────
    test('a persisted assessment records asset + exact amount, never a GHS amount as USDC', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 100 });
        // Only a DECISION that triggers a rule is persisted (that is the audit
        // trail of something that happened), so both amounts trip a rule.
        await fraudService.evaluate({
            userId: user.id, type: 'WITHDRAWAL', asset: 'GHS', amount: '2500.00',
            velocityTypes: ['WITHDRAWAL_FIAT'], riskDataMode: 'FAIL_CLOSED',
        });
        await fraudService.evaluate({
            userId: user.id, type: 'WITHDRAWAL', asset: 'USDC', amount: '12000.00',
            velocityTypes: ['WITHDRAWAL_CRYPTO'], riskDataMode: 'FAIL_CLOSED',
        });
        // the write is intentionally fire-and-forget, so poll rather than race it
        let rows = [];
        for (let i = 0; i < 40 && rows.length < 2; i += 1) {
            rows = await prisma.fraudAssessment.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
            if (rows.length < 2) await new Promise((r) => setTimeout(r, 50));
        }
        const ghs = rows.find((r) => r.asset === 'GHS');
        const usdc = rows.find((r) => r.asset === 'USDC');
        expect(ghs).toBeTruthy();
        expect(String(ghs.amountExact)).toBe('2500');
        // a GHS amount NEVER lands in the USDC column: 2,500 cedis is not $2,500
        expect(String(ghs.amountUsdc)).toBe('0');
        expect(usdc).toBeTruthy();
        expect(String(usdc.amountExact)).toBe('12000');
        expect(String(usdc.amountUsdc)).toBe('12000');
        // and the rule that fired on the GHS row is the GHS rule, not the USDC one
        // parsed, not substring-matched: "GHS_LARGE_WITHDRAWAL" CONTAINS the
        // USDC rule name, so a string assertion would be a false positive.
        const ghsRules = JSON.parse(ghs.triggeredRules);
        expect(ghsRules).toContain('GHS_LARGE_WITHDRAWAL');
        expect(ghsRules).not.toContain('LARGE_WITHDRAWAL');
        expect(JSON.parse(usdc.triggeredRules)).toContain('HUGE_WITHDRAWAL');
    });

    // ── §P0-4 capability gates BOTH bank entry points ───────────────────────
    test.each([
        ['capability disabled', () => ({ ...bankPortCols(), capabilities: () => ({ canInitiateBankPayout: false, mode: 'disabled' }) })],
        ['capability throws', () => ({ ...bankPortCols(), capabilities: () => { throw new Error('misconfigured'); } })],
        ['capability malformed', () => ({ ...bankPortCols(), capabilities: () => ({ mode: 'sandbox' }) })],
        ['no capability method', () => { const p = { ...bankPortCols() }; delete p.capabilities; return p; }],
        ['no port at all', () => null],
    ])('%s: no mutation, no quote, no payout', async (_label, makePort) => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 1 });
        const bank = await verifiedBeneficiary(user.id);
        const app = buildApp({ port: makePort() });
        const before = await stateOf(user.id);

        const quote = await bankQuote(app, user, { amountGhs: '50.00', beneficiaryId: bank.id });
        expect(quote.status).toBe(503);
        expect(quote.body.code).toBe('BANK_PAYOUT_CAPABILITY_UNAVAILABLE');

        const payout = await bankPost(app, user, { amountGhs: '50.00', beneficiaryId: bank.id });
        expect(payout.status).toBe(503);
        expect(payout.body.code).toBe('BANK_PAYOUT_CAPABILITY_UNAVAILABLE');
        expect(await stateOf(user.id)).toEqual(before);
    });

    function bankPortCols() {
        // A port that LOOKS complete: the point is that looking complete is not
        // evidence, so these fixtures vary only the capability answer.
        const c = bankPort().port;
        return {
            listBanks: c.listBanks,
            validateBankAccount: c.validateBankAccount,
            capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: jest.fn(async () => ({ status: 'PENDING' })),
            getBankTransferStatus: c.getBankTransferStatus,
        };
    }

    // ── §P1C directory ──────────────────────────────────────────────────────
    describe('bank directory', () => {
        test('codes stay strings, leading zeroes survive, cache state is honest', async () => {
            const dir = await beneficiaries.listBankDirectory(bankPort().port);
            expect(dir.banks).toEqual([
                { code: 'GCB', name: 'GCB Bank' },
                { code: '030100', name: 'Leading Zero Bank' },
            ]);
            expect(dir.stale).toBe(false);
            expect(typeof dir.banks[1].code).toBe('string');
        });

        test('an unavailable or empty directory is a 503, never a partial list', async () => {
            const throwing = { listBanks: async () => { throw new Error('down'); } };
            await expect(beneficiaries.listBankDirectory(throwing)).rejects.toMatchObject({ code: 'BANK_DIRECTORY_UNAVAILABLE' });
            const empty = { listBanks: async () => ({ stale: false, banks: [] }) };
            await expect(beneficiaries.listBankDirectory(empty)).rejects.toMatchObject({ code: 'BANK_DIRECTORY_UNAVAILABLE' });
            await expect(beneficiaries.listBankDirectory(null)).rejects.toMatchObject({ code: 'BANK_DIRECTORY_UNAVAILABLE' });
        });
    });

    // ── §P1C update + revalidate ────────────────────────────────────────────
    describe('beneficiary update and revalidation', () => {
        test('nickname and primary are updatable; the destination is not', async () => {
            const user = await seedUser(prisma, {});
            const bank = await verifiedBeneficiary(user.id);
            const updated = await beneficiaries.updateBeneficiary(prisma, user.id, bank.id, { nickname: 'Landlord' });
            expect(updated.nickname).toBe('Landlord');
            expect(updated.accountNumberMasked).toBe(bank.accountNumberMasked);

            for (const patch of [{ accountNumber: '1234567899' }, { bankCode: 'ECO' }, { bankName: 'Ecobank' }]) {
                await expect(beneficiaries.updateBeneficiary(prisma, user.id, bank.id, patch))
                    .rejects.toMatchObject({ code: 'BENEFICIARY_FIELD_IMMUTABLE' });
            }
            // and the stored destination is untouched by the attempts
            const after = await prisma.savedBankBeneficiary.findUnique({ where: { id: bank.id } });
            expect(after.bankCode).toBe('GCB');
            expect(after.accountNumberHmac).toBe(await prisma.savedBankBeneficiary.findUnique({ where: { id: bank.id } }).then((r) => r.accountNumberHmac));
        });

        test('promoting a new primary demotes the old one, leaving exactly one', async () => {
            const user = await seedUser(prisma, {});
            const first = await verifiedBeneficiary(user.id, { accountNumber: '0123456789', isPrimary: true });
            const second = await verifiedBeneficiary(user.id, { accountNumber: '9876543210', isPrimary: false });
            await beneficiaries.updateBeneficiary(prisma, user.id, second.id, { isPrimary: true });
            const primaries = await prisma.savedBankBeneficiary.count({
                where: { userId: user.id, status: 'ACTIVE', isPrimary: true },
            });
            expect(primaries).toBe(1);
            const firstNow = await prisma.savedBankBeneficiary.findUnique({ where: { id: first.id } });
            expect(firstNow.isPrimary).toBe(false);
        });

        test('another owner cannot update or revalidate a payee', async () => {
            const owner = await seedUser(prisma, {});
            const stranger = await seedUser(prisma, {});
            const bank = await verifiedBeneficiary(owner.id);
            await expect(beneficiaries.updateBeneficiary(prisma, stranger.id, bank.id, { nickname: 'x' }))
                .rejects.toMatchObject({ code: 'BENEFICIARY_NOT_FOUND' });
            await expect(beneficiaries.revalidateBeneficiary(prisma, stranger.id, bank.id, { port: bankPort().port }))
                .rejects.toMatchObject({ code: 'BENEFICIARY_NOT_FOUND' });
        });

        test('revalidation binds the provider answer to the STORED account, and a definitive failure withdraws it', async () => {
            const user = await seedUser(prisma, {});
            const bank = await verifiedBeneficiary(user.id);
            const { port } = bankPort();
            const ok = await beneficiaries.revalidateBeneficiary(prisma, user.id, bank.id, { port });
            expect(ok.beneficiary.validatedAt).toBeTruthy();
            // the provider was asked about the STORED digits, not a client value
            expect(port.validateBankAccount).toHaveBeenCalledWith(expect.objectContaining({ accountNumber: ACCOUNT, bankCode: 'GCB' }));
            expect(JSON.stringify(ok.beneficiary)).not.toContain(ACCOUNT);

            // a definitive provider answer (account gone) clears the evidence
            const gone = bankPort().port;
            gone.validateBankAccount = jest.fn(async () => { const e = new Error('not found'); e.code = 'ACCOUNT_NOT_FOUND'; throw e; });
            await expect(beneficiaries.revalidateBeneficiary(prisma, user.id, bank.id, { port: gone }))
                .rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
            const row = await prisma.savedBankBeneficiary.findUnique({ where: { id: bank.id } });
            expect(row.validatedAt).toBeNull();
            // an inconclusive failure leaves the previous evidence intact
            const flaky = bankPort().port;
            flaky.validateBankAccount = jest.fn(async () => ({ valid: false }));
            await expect(beneficiaries.revalidateBeneficiary(prisma, user.id, bank.id, { port: flaky }))
                .rejects.toMatchObject({ code: 'VALIDATION_UNDETERMINED' });
        });
    });

    // ── §P1-6 one account-length contract ───────────────────────────────────
    test('account length is enforced identically at the HTTP layer', () => {
        const body = (accountNumber) => ({ bankCode: 'GCB', bankName: 'GCB Bank', accountNumber });
        const ok = (n) => schemas.bankBeneficiarySchema.safeParse(body(n)).success;
        expect(ok('012345678')).toBe(false);         // 9
        expect(ok('0123456789')).toBe(true);         // 10
        expect(ok('0123456789012345')).toBe(true);   // 16
        expect(ok('01234567890123456')).toBe(false); // 17
        expect(ok('01234-56789')).toBe(true);        // separators are formatting; the service strips them too
        // the domain service agrees on the same boundaries
        expect(() => beneficiaries.normalizeAccountNumber('012345678')).toThrow();
        expect(beneficiaries.normalizeAccountNumber('0123456789')).toBe('0123456789');
        expect(beneficiaries.normalizeAccountNumber('0123456789012345')).toBe('0123456789012345');
        expect(() => beneficiaries.normalizeAccountNumber('01234567890123456')).toThrow();
    });
});
