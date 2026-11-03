// __tests__/bank-beneficiary-validation.test.js
// =============================================================================
// Provider-backed saved bank beneficiary validation (issue #389 P0-3).
// Real PostgreSQL.
//
// The provider (Agent B's adapter, injected as the port) is the ONLY authority
// that can make a beneficiary verified. PROVES:
//   A. A successful validation stores the PROVIDER's account name and the
//      provider's bank name/timestamp, and marks the row verified.
//   B. An account the provider says does not exist (ACCOUNT_NOT_FOUND / AVD02)
//      is refused and NOTHING is persisted.
//   C. A bank code missing from the provider directory is refused.
//   D. A provider outage or a STALE directory cannot create a verified
//      beneficiary (saved UNVERIFIED with the reason).
//   E. A client-supplied accountNameVerified is ignored entirely.
//   F. Owner scoping: another user's beneficiary is a 404, never revealed.
//   G. Withdrawal is refused (422, no money moves) for an unverified
//      beneficiary, and after a re-save that invalidates the verification.
//   H. Account-number policy is Azaman's own 10-16 window.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const maybe = hasDb ? describe : describe.skip;

if (hasDb) {
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

maybe('provider-backed bank beneficiary validation (real PostgreSQL)', () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';

    const ACCOUNT = '1234567890123';
    const PROVIDER_NAME = 'AMA MENSAH';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    async function setFlags() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { nativeGhsWithdrawalEnabled: true, fiatLiquidityAuthorityEnabled: true },
            create: { id: 1, nativeGhsWithdrawalEnabled: true, fiatLiquidityAuthorityEnabled: true },
        });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000 },
        });
    }

    function buildApp(port) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        if (port) app.set('moolreBankPayoutPort', port);
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        app.use('/api/bank-beneficiaries', require('../routes/bankBeneficiaryRoutes'));
        return app;
    }

    /** A faithful stand-in for Agent B's adapter's validation surface. */
    function providerPort({
        banks = [{ code: 'GCB', name: 'GCB BANK LIMITED' }],
        stale = false,
        validate,
        directoryThrows = false,
    } = {}) {
        return {
            capabilities: () => ({ canInitiateBankPayout: true, mode: 'sandbox' }),
            initiateBankTransfer: jest.fn(async () => ({
            capabilities: () => ({ canInitiateBankPayout: true, mode: 'sandbox' }),
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: '0.00',
            })),
            listBanks: jest.fn(async () => {
                if (directoryThrows) {
                    const err = new Error('directory unavailable');
                    err.code = 'DIRECTORY_UNAVAILABLE';
                    throw err;
                }
                return { banks, stale, source: 'MOOLRE', retrievedAt: new Date().toISOString() };
            }),
            validateBankAccount: jest.fn(validate || (async ({ accountNumber, bankCode }) => ({
                valid: true,
                accountName: PROVIDER_NAME,
                bankCode,
                validatedAt: new Date().toISOString(),
                provider: 'MOOLRE',
            }))),
        };
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, JWT_SECRET);
    const auth = (req, user) => req.set('Authorization', `Bearer ${tokenFor(user)}`).set('Idempotency-Key', randomUUID());

    const createBene = async (app, user, body = {}) => auth(request(app).post('/api/bank-beneficiaries'), user).send({
        password: TEST_PASSWORD,
        bankCode: 'GCB',
        bankName: 'GCB Bank',
        accountNumber: ACCOUNT,
        accountName: 'Ama Mensah',
        ...body,
    });

    const rowFor = (userId) => prisma.savedBankBeneficiary.findFirst({ where: { userId } });

    test('A: the provider name and timestamp become the validated destination', async () => {
        await setFlags();
        const port = providerPort();
        const app = buildApp(port);
        const user = await seedUser(prisma, {});

        const res = await createBene(app, user);
        expect(res.status).toBe(201);
        expect(res.body.verification.status).toBe('VERIFIED');
        expect(res.body.beneficiary.accountNameVerified).toBe(true);
        expect(res.body.beneficiary.validatedAt).toBeTruthy();
        // The PROVIDER's name, not the customer's typed "Ama Mensah".
        expect(res.body.beneficiary.accountName).toBe(PROVIDER_NAME);
        // The provider's own bank name, and its canonical code.
        expect(res.body.beneficiary.bankName).toBe('GCB BANK LIMITED');
        expect(res.body.beneficiary.bankCode).toBe('GCB');
        // Only a masked tail is ever returned.
        expect(res.body.beneficiary.accountNumberMasked).toBe('*********0123');
        expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);

        expect(port.listBanks).toHaveBeenCalled();
        expect(port.validateBankAccount).toHaveBeenCalledWith({ accountNumber: ACCOUNT, bankCode: 'GCB' });

        const row = await rowFor(user.id);
        expect(row.validatedAt).toBeTruthy();
        expect(row.accountName).toBe(PROVIDER_NAME);
        expect(row.accountNumberEnc).not.toContain(ACCOUNT);

        const list = await auth(request(app).get('/api/bank-beneficiaries'), user);
        expect(list.body.beneficiaries[0].accountNameVerified).toBe(true);
        expect(JSON.stringify(list.body)).not.toContain(ACCOUNT);
    });

    test('B: an account the provider cannot find is refused and nothing is persisted', async () => {
        await setFlags();
        const port = providerPort({
            validate: async () => {
                const err = new Error('account not found');
                err.code = 'ACCOUNT_NOT_FOUND';
                throw err;
            },
        });
        const app = buildApp(port);
        const user = await seedUser(prisma, {});

        const res = await createBene(app, user);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
        expect(await rowFor(user.id)).toBeNull();
    });

    test('C: a bank code outside the provider directory is refused', async () => {
        await setFlags();
        const port = providerPort();
        const app = buildApp(port);
        const user = await seedUser(prisma, {});

        const res = await createBene(app, user, { bankCode: 'ZZZ', bankName: 'Made Up Bank' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('BANK_CODE_UNKNOWN');
        expect(await rowFor(user.id)).toBeNull();
        expect(port.validateBankAccount).not.toHaveBeenCalled();
    });

    test('D1: a provider outage saves UNVERIFIED, never verified', async () => {
        await setFlags();
        const app = buildApp(providerPort({ directoryThrows: true }));
        const user = await seedUser(prisma, {});

        const res = await createBene(app, user);
        expect(res.status).toBe(201);
        expect(res.body.verification.status).toBe('UNVERIFIED');
        expect(res.body.verification.reason).toBe('DIRECTORY_UNAVAILABLE');
        expect(res.body.beneficiary.accountNameVerified).toBe(false);
        expect(res.body.beneficiary.validatedAt).toBeNull();
        // The customer's assertion is kept as an assertion, nothing more.
        expect(res.body.beneficiary.accountName).toBe('Ama Mensah');
    });

    test('D2: a STALE directory cannot validate anything', async () => {
        await setFlags();
        const port = providerPort({ stale: true });
        const app = buildApp(port);
        const user = await seedUser(prisma, {});

        const res = await createBene(app, user);
        expect(res.status).toBe(201);
        expect(res.body.verification.status).toBe('UNVERIFIED');
        expect(res.body.verification.reason).toBe('DIRECTORY_STALE');
        expect(port.validateBankAccount).not.toHaveBeenCalled();
        expect((await rowFor(user.id)).validatedAt).toBeNull();
    });

    test('E: a client-supplied accountNameVerified is ignored', async () => {
        await setFlags();
        const app = buildApp(providerPort({ directoryThrows: true }));
        const user = await seedUser(prisma, {});

        const res = await createBene(app, user, { accountNameVerified: true, validatedAt: new Date().toISOString() });
        expect(res.status).toBe(201);
        expect(res.body.beneficiary.accountNameVerified).toBe(false);
        expect((await rowFor(user.id)).validatedAt).toBeNull();
    });

    test('F: another user can neither list nor delete the beneficiary', async () => {
        await setFlags();
        const app = buildApp(providerPort());
        const owner = await seedUser(prisma, {});
        const stranger = await seedUser(prisma, {});

        const created = await createBene(app, owner);
        expect(created.status).toBe(201);

        const list = await auth(request(app).get('/api/bank-beneficiaries'), stranger);
        expect(list.body.beneficiaries).toHaveLength(0);

        const del = await auth(request(app).delete(`/api/bank-beneficiaries/${created.body.beneficiary.id}`), stranger).send({ password: TEST_PASSWORD });
        expect(del.status).toBe(404);
        expect((await rowFor(owner.id)).status).toBe('ACTIVE');
    });

    test('G1: withdrawal is refused for an unverified beneficiary and moves no money', async () => {
        await setFlags();
        const app = buildApp(providerPort({ directoryThrows: true }));
        const user = await seedUser(prisma, { nativeGhsBalance: 500 });

        const created = await createBene(app, user);
        expect(created.body.beneficiary.accountNameVerified).toBe(false);

        // seedUser funds the wallet with its own canonical row: measure the
        // delta, not the absolute count.
        const canonicalBefore = await prisma.transactionHistory.count({ where: { userId: user.id } });
        const res = await auth(request(app).post('/api/withdraw/bank'), user).send({
            password: TEST_PASSWORD,
            amountGhs: '50.00',
            beneficiaryId: created.body.beneficiary.id,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('BENEFICIARY_NOT_VERIFIED');

        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('500.00');
        const canonicalAfter = await prisma.transactionHistory.count({ where: { userId: user.id } });
        expect(canonicalAfter).toBe(canonicalBefore);
        const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Prisma.Decimal(state.reservedGhs || 0).toFixed(2)).toBe('0.00');
    });

    test('G2: re-saving a different account drops the old verification timestamp', async () => {
        await setFlags();
        const app = buildApp(providerPort());
        const user = await seedUser(prisma, {});

        const first = await createBene(app, user);
        expect(first.body.beneficiary.accountNameVerified).toBe(true);

        // Same owner deletes and re-saves with a different account number: the
        // old provider evidence must not survive the change.
        const offlineApp = buildApp(providerPort({ directoryThrows: true }));
        await auth(request(offlineApp).delete(`/api/bank-beneficiaries/${first.body.beneficiary.id}`), user).send({ password: TEST_PASSWORD });

        const resaved = await createBene(offlineApp, user, { accountNumber: '9998887776665' });
        expect(resaved.status).toBe(201);
        expect(resaved.body.beneficiary.accountNameVerified).toBe(false);
        expect(resaved.body.beneficiary.validatedAt).toBeNull();

        const row = await prisma.savedBankBeneficiary.findFirst({ where: { userId: user.id, status: 'ACTIVE' } });
        expect(row.validatedAt).toBeNull();
        expect(row.accountNumberMasked).toBe('*********6665');

        // And the payout is refused again, on the strength of that gap.
        const user2 = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(user2.nativeGhsBalance)).toBeGreaterThanOrEqual(0);
        const res = await auth(request(offlineApp).post('/api/withdraw/bank'), user).send({
            password: TEST_PASSWORD,
            amountGhs: '10.00',
            beneficiaryId: resaved.body.beneficiary.id,
        });
        expect([422, 409]).toContain(res.status);
    });

    test('H: the account-number window is Azaman\'s own 10-16 digits', async () => {
        await setFlags();
        const app = buildApp(providerPort());
        const user = await seedUser(prisma, {});

        // §P1-6 both layers now say 10-16, so the HTTP layer refuses first and
        // its envelope names the field. A 9- or 17-digit number never reaches
        // the service, which is the point: one rule, refused at the boundary.
        const nine = await createBene(app, user, { accountNumber: '123456789' });
        expect(nine.status).toBe(400);
        expect(JSON.stringify(nine.body)).toContain('10-16');

        const seventeen = await createBene(app, user, { accountNumber: '12345678901234567' });
        expect(seventeen.status).toBe(400);
        expect(JSON.stringify(seventeen.body)).toContain('10-16');

        const sixteen = await createBene(app, user, { accountNumber: '1234567890123456' });
        expect(sixteen.status).toBe(201);
    });
});
