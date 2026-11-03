// __tests__/native-ghs-bank-quote.test.js
// =============================================================================
// Issue #389 P0-2 / P1-3: the BANK rail's shortfall quote, end to end.
//
// Before this, a bank payout that native GHS could not cover answered
// GHS_SHORTFALL_QUOTE_REQUIRED — and there was NO way to obtain that quote. The
// only quote route resolved MoMo destinations, so the BANK digest the payout
// consumes (fingerprint + bank code) could never be minted. A rail whose quote
// cannot be produced is a rail whose shortfall path does not exist.
//
// PROVES:
//   A. The full lifecycle: BANK quote -> consent -> BANK payout, with the exact
//      8dp USDC debit, the GHS recipient moved and the quote consumed once.
//   B. A quote cannot fund a different BANK payee (same digits, other bank),
//      a different amount, or a different rail. Nothing moves, the quote is
//      not consumed.
//   C. Another owner's beneficiary and an unverified payee cannot be quoted.
//   D. A balance change between quote and payout refuses and leaves the quote
//      unconsumed.
//   E. Quote replay is refused.
//   F. §P1-3 a non-zero bank fee cannot enable the rail (fail closed), and the
//      zero-fee policy is explicit.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-bank-quote] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
}

(hasDb ? describe : describe.skip)('BANK shortfall quote lifecycle (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;
    let beneficiaries;
    let svc;

    const RATE = 12.5;
    const DIGITS = '1234567890123';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        beneficiaries = require('../src/services/savedBankBeneficiaryService');
        svc = require('../src/services/nativeGhsWithdrawalService');
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    beforeEach(() => { process.env.BANK_PAYOUT_FEE_GHS = '0'; });
    afterEach(() => { delete process.env.BANK_PAYOUT_FEE_GHS; });

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

    function bankPort({ verified = true } = {}) {
        return {
            listBanks: jest.fn(async () => ({ stale: false, banks: [
                { code: 'GCB', name: 'GCB Bank' },
                { code: 'ECO', name: 'Ecobank Ghana' },
            ] })),
            validateBankAccount: jest.fn(async () => (verified
                ? { valid: true, accountName: 'AMA MENSAH' }
                : { valid: false })),
            initiateBankTransfer: jest.fn(async () => ({ status: 'PENDING', externalId: 'ext-1', providerRef: 'MUL-1' })),
            getBankTransferStatus: jest.fn(async () => ({ status: 'PENDING' })),
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

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);
    const quotePost = (app, user, body) => auth(request(app).post('/api/withdraw/bank/quote'), user)
        .set('Idempotency-Key', randomUUID()).send(body);
    const bankPost = (app, user, body) => auth(request(app).post('/api/withdraw/bank'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, ...body });
    const ghsPost = (app, user, body) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, network: 'MTN', ...body });

    async function makeBeneficiary(userId, { bankCode = 'GCB', accountNumber = DIGITS, port = bankPort() } = {}) {
        return beneficiaries.createBeneficiary(prisma, userId, {
            bankCode, bankName: bankCode === 'GCB' ? 'GCB Bank' : 'Ecobank Ghana',
            accountNumber, accountName: 'Ama Mensah',
        }, { port });
    }

    async function stateOf(userId) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { nativeGhsBalance: true, availableBalance: true } });
        const liquidity = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        return {
            nativeGhs: new Prisma.Decimal(user.nativeGhsBalance).toFixed(2),
            available: new Prisma.Decimal(user.availableBalance).toFixed(8),
            ledgerRows: await prisma.ledgerTransaction.count({ where: { userId } }),
            withdrawals: await prisma.withdrawal.count({ where: { userId } }),
            reservedGhs: new Prisma.Decimal(liquidity.reservedGhs).toFixed(2),
            inTransitGhs: new Prisma.Decimal(liquidity.inTransitGhs).toFixed(2),
        };
    }
    const quoteConsumed = async (quoteId) => {
        const rows = await prisma.$queryRawUnsafe('SELECT "consumedAt" FROM "TransactionQuote" WHERE "id" = $1::uuid', quoteId);
        return rows[0]?.consumedAt != null;
    };

    // ── A. the lifecycle ───────────────────────────────────────────────────
    test('A: BANK quote -> consent -> payout, exact 8dp debit, quote consumed once', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const port = bankPort();
        const app = buildApp(port);

        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        expect(quoted.status).toBe(200);
        expect(quoted.body.quote.intent.rail).toBe('BANK');
        expect(quoted.body.quote.intent.recipientGhs).toBe('100.00');
        expect(quoted.body.quote.intent.destinationIdentity).toMatch(/^fp:[A-Za-z0-9_-]+@GCB$/);
        expect(quoted.body.plan.shortfallGhs).toBe('80.00');
        const { quoteId } = quoted.body.quote;
        const usdcDebit = quoted.body.quote.usdcDebit;

        const before = await stateOf(user.id);
        const res = await bankPost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id, quoteId });
        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);

        const after = await stateOf(user.id);
        // USDC: exactly the disclosed 8dp debit.
        expect(new Prisma.Decimal(before.available).minus(after.available).toFixed(8)).toBe(usdcDebit);
        expect(after.nativeGhs).toBe('0.00');
        expect(after.withdrawals).toBe(before.withdrawals + 1);
        expect(await quoteConsumed(quoteId)).toBe(true);

        // E. replay: the same quote cannot fund a second payout.
        const replay = await bankPost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id, quoteId });
        expect(replay.status).toBeGreaterThanOrEqual(400);
    });

    // ── B. intent mismatches ───────────────────────────────────────────────
    test('B1: the same digits under a DIFFERENT bank code cannot spend the quote', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id, { bankCode: 'GCB' });
        const port = bankPort();
        const app = buildApp(port);
        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        expect(quoted.status).toBe(200);
        const { quoteId } = quoted.body.quote;
        expect(quoted.body.quote.intent.destinationIdentity).toMatch(/@GCB$/);

        // The payee record now names a different bank for the same digits. The
        // account number is only unique WITHIN a bank, so this is a different
        // payee and the consent no longer covers it.
        await prisma.savedBankBeneficiary.update({ where: { id: bene.id }, data: { bankCode: 'ECO' } });

        const before = await stateOf(user.id);
        const res = await bankPost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id, quoteId });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(String(res.body.code || '')).toBe('NATIVE_GHS_QUOTE_INTENT_MISMATCH');
        expect(await stateOf(user.id)).toEqual(before);
        expect(await quoteConsumed(quoteId)).toBe(false);
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();
    });

    test('B2: a changed amount cannot spend the quote', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const port = bankPort();
        const app = buildApp(port);
        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        const { quoteId } = quoted.body.quote;
        const before = await stateOf(user.id);
        const res = await bankPost(app, user, { amountGhs: '111.00', beneficiaryId: bene.id, quoteId });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await stateOf(user.id)).toEqual(before);
        expect(await quoteConsumed(quoteId)).toBe(false);
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();
    });

    test('B3: a BANK quote cannot fund a MoMo payout', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const app = buildApp(bankPort());
        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        const { quoteId } = quoted.body.quote;
        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '100.00', destination: '233241234567', quoteId });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await stateOf(user.id)).toEqual(before);
        expect(await quoteConsumed(quoteId)).toBe(false);
    });

    // ── C. beneficiary scoping and verification ────────────────────────────
    test('C1: another owner\'s beneficiary cannot be quoted', async () => {
        await setSettings();
        const owner = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const stranger = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const theirs = await makeBeneficiary(owner.id);
        const app = buildApp(bankPort());
        const res = await quotePost(app, stranger, { amountGhs: '100.00', beneficiaryId: theirs.id });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BENEFICIARY_NOT_FOUND');
    });

    test('C2: an unverified beneficiary cannot be quoted', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        await makeBeneficiary(user.id, { port: bankPort({ verified: false }) });
        // createBeneficiary refuses an unverifiable account outright, so build
        // the unverified row the way a stale/legacy record looks: saved, active,
        // never validated.
        const row = await prisma.savedBankBeneficiary.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
        expect(row).toBeTruthy();
        await prisma.savedBankBeneficiary.update({ where: { id: row.id }, data: { validatedAt: null, isPrimary: false } });
        const app = buildApp(bankPort());
        const res = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: row.id });
        expect(res.status).toBe(422);
        expect(String(res.body.code || '')).toMatch(/BENEFICIARY_NOT_VERIFIED|BENEFICIARY_UNVERIFIED/);
    });

    // ── D. balance changed after the quote ─────────────────────────────────
    test('D: a native balance change after the quote refuses and keeps the quote', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const port = bankPort();
        const app = buildApp(port);
        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        const { quoteId } = quoted.body.quote;
        // The customer received GHS in the meantime: the quoted shortfall (80)
        // is no longer the real one (70).
        await prisma.user.update({ where: { id: user.id }, data: { nativeGhsBalance: 30 } });
        const before = await stateOf(user.id);
        const res = await bankPost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id, quoteId });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(String(res.body.code || '')).toBe('NATIVE_GHS_QUOTE_INTENT_CHANGED');
        expect(await stateOf(user.id)).toEqual(before);
        expect(await quoteConsumed(quoteId)).toBe(false);
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();
    });

    // ── F. fee policy ──────────────────────────────────────────────────────
    test('F1: a NON-ZERO bank fee refuses to quote AND to pay (fail closed)', async () => {
        process.env.BANK_PAYOUT_FEE_GHS = '2.50';
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const port = bankPort();
        const app = buildApp(port);

        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        expect(quoted.status).toBe(503);
        expect(quoted.body.code).toBe('BANK_FEE_POLICY_UNAPPROVED');

        const before = await stateOf(user.id);
        const paid = await bankPost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        expect(paid.status).toBeGreaterThanOrEqual(400);
        expect(String(paid.body.code || '')).toMatch(/BANK_FEE_POLICY_UNAPPROVED|BANK_FEE_POLICY_UNEVIDENCED/);
        expect(await stateOf(user.id)).toEqual(before);
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();
    });

    test('F2: an ABSENT fee policy refuses too — silence is not an agreement', async () => {
        delete process.env.BANK_PAYOUT_FEE_GHS;
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const app = buildApp(bankPort());
        const quoted = await quotePost(app, user, { amountGhs: '100.00', beneficiaryId: bene.id });
        expect(quoted.status).toBe(503);
        expect(quoted.body.code).toBe('BANK_FEE_POLICY_UNEVIDENCED');
    });

    test('F3: the reversal refunds the FULL debit, fee included, when one is charged', async () => {
        // The rail cannot charge a fee today (F1), but the refund invariant must
        // hold by construction: the debit is recipient + fee, so the reversal
        // must return recipient + the fee that was actually charged.
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 300, availableBalance: 1000 });
        const bene = await makeBeneficiary(user.id);
        const bank = await beneficiaries.revealForPayout(prisma, user.id, bene.id);
        const reference = randomUUID();
        await svc.processNativeGhsWithdrawal(
            prisma,
            user.id,
            {
                amountGhs: '50.00',
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: {
                    beneficiaryId: bank.id, bankCode: bank.bankCode, bankName: bank.bankName,
                    accountNumberMasked: bank.accountNumberMasked,
                    fingerprint: beneficiaries.fingerprint(bank.accountNumber),
                    capturedAt: new Date().toISOString(),
                },
            },
            { commitOperationClaimInTransaction: async () => {} }
        );
        // 300 - 50 debited.
        const afterDebit = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(afterDebit.nativeGhsBalance).toFixed(2)).toBe('250.00');

        // Record the fee such a row WOULD carry under an approved non-zero policy.
        await prisma.$executeRawUnsafe(
            'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object(\'feeGhs\', \'2.50\') WHERE "txHash" = $1',
            reference
        );

        const out = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'test_definitive_failure' });
        expect(out.reversed).toBe(true);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        // recipient 50.00 + recorded fee 2.50 returned, not just the recipient.
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('302.50');
    });
});
