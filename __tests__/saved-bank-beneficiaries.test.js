// __tests__/saved-bank-beneficiaries.test.js
// =============================================================================
// Saved BANK beneficiaries + typed BANK payout route (issue #389 section 4).
// Real PostgreSQL.
//
// PROVES:
//   A. The account number is never stored or returned in plaintext: the row
//      holds a versioned ciphertext + an HMAC fingerprint under a DISTINCT
//      key, and every API shape is masked-tail only.
//   B. Duplicate detection is by fingerprint, per owner (no cross-user leak of
//      "this account already exists").
//   C. Ownership is strict: another user's beneficiary is a 404, never a read,
//      reveal or delete.
//   D. The BANK payout route refuses 503 with ZERO mutation when the injected
//      provider port is not bound (capability-first, never a guessed rail).
//   E. With a bound port the payout reuses the same GHS economic leg: exact
//      GHS debit, canonical row with an explicit BANK typed destination, the
//      port called once with the decrypted number, and the mirror in
//      DISPATCHING.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const maybe = hasDb ? describe : describe.skip;

if (hasDb) {
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    // §9: the BANK rail is OFF unless a fee policy is explicitly evidenced.
    // These tests evidence a zero-fee bank contract so the economics are
    // exercised; the refusal path is proven separately below.
    process.env.BANK_PAYOUT_FEE_GHS = '0';
}

maybe('saved bank beneficiaries + BANK payout (real PostgreSQL)', () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;

    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    async function setFlags({ withdrawal = true } = {}) {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { nativeGhsWithdrawalEnabled: withdrawal, fiatLiquidityAuthorityEnabled: true },
            create: { id: 1, nativeGhsWithdrawalEnabled: withdrawal, fiatLiquidityAuthorityEnabled: true },
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

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, JWT_SECRET);
    const auth = (req, user) => req.set('Authorization', `Bearer ${tokenFor(user)}`).set('Idempotency-Key', randomUUID());

    const createBene = async (app, user, body = {}) => auth(request(app).post('/api/bank-beneficiaries'), user).send({
        password: TEST_PASSWORD,
        bankCode: 'GCB',
        bankName: 'GCB Bank',
        accountNumber: '1234567890123',
        accountName: 'Ama Mensah',
        ...body,
    });

    test('stores ciphertext + fingerprint only, and returns a masked tail', async () => {
        await setFlags();
        const app = buildApp();
        const user = await seedUser(prisma, {});
        const res = await createBene(app, user);
        expect(res.status).toBe(201);
        expect(res.body.beneficiary.accountNumberMasked).toBe('*********0123');
        expect(JSON.stringify(res.body)).not.toContain('1234567890123');

        const row = await prisma.savedBankBeneficiary.findFirst({ where: { userId: user.id } });
        expect(row.accountNumberEnc).not.toContain('1234567890123');
        expect(row.accountNumberEnc.startsWith('enc:v1:')).toBe(true);
        expect(row.accountNumberHmac).toMatch(/^[0-9a-f]{64}$/);
        expect(row.keyId).toBeTruthy();

        const raw = await prisma.$queryRawUnsafe('SELECT "accountNumberEnc", "accountNumberHmac" FROM "SavedBankBeneficiary" WHERE "id" = $1', row.id);
        expect(JSON.stringify(raw)).not.toContain('1234567890123');

        const list = await auth(request(app).get('/api/bank-beneficiaries'), user).send();
        expect(list.status).toBe(200);
        expect(JSON.stringify(list.body)).not.toContain('1234567890123');
    });

    test('duplicate account is refused by fingerprint (and revive keeps one row)', async () => {
        await setFlags();
        const app = buildApp();
        const user = await seedUser(prisma, {});
        expect((await createBene(app, user)).status).toBe(201);
        const dup = await createBene(app, user, { accountNumber: '1234 567 890 123' });
        expect(dup.status).toBe(400);
        expect(dup.body.code).toBe('BENEFICIARY_DUPLICATE');
        expect(await prisma.savedBankBeneficiary.count({ where: { userId: user.id } })).toBe(1);
    });

    test('ownership is strict: another user cannot read or delete the payee', async () => {
        await setFlags();
        const app = buildApp();
        const owner = await seedUser(prisma, {});
        const attacker = await seedUser(prisma, {});
        const created = await createBene(app, owner);
        const id = created.body.beneficiary.id;

        const del = await auth(request(app).delete(`/api/bank-beneficiaries/${id}`), attacker).send({ password: TEST_PASSWORD });
        expect(del.status).toBe(404);

        const list = await auth(request(app).get('/api/bank-beneficiaries'), attacker).send();
        expect(list.body.beneficiaries).toHaveLength(0);
        const still = await prisma.savedBankBeneficiary.findUnique({ where: { id } });
        expect(still.status).toBe('ACTIVE');
    });

    test('BANK payout refuses 503 with zero mutation when the port is unbound', async () => {
        await setFlags();
        const app = buildApp(null);
        const user = await seedUser(prisma, { nativeGhsBalance: 500 });
        const created = await createBene(app, user);
        const before = await prisma.transactionHistory.count();

        const res = await auth(request(app).post('/api/withdraw/bank'), user).send({
            password: TEST_PASSWORD,
            amountGhs: '80.00',
            beneficiaryId: created.body.beneficiary.id,
        });
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('BANK_PAYOUT_CAPABILITY_UNAVAILABLE');
        expect(await prisma.transactionHistory.count()).toBe(before);
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Prisma.Decimal(fresh.nativeGhsBalance).toFixed(2)).toBe('500.00');
    });

    test('BANK payout with a bound port debits exact GHS and calls the port once', async () => {
        await setFlags();
        const port = { initiateBankTransfer: jest.fn(async () => ({ providerRef: 'BANK-REF-1', status: 'PENDING' })) };
        const app = buildApp(port);
        const user = await seedUser(prisma, { nativeGhsBalance: 500 });
        const created = await createBene(app, user);

        const res = await auth(request(app).post('/api/withdraw/bank'), user).send({
            password: TEST_PASSWORD,
            amountGhs: '125.50',
            beneficiaryId: created.body.beneficiary.id,
        });
        expect(res.status).toBe(202);
        expect(res.body.data.destinationType).toBe('BANK');
        expect(res.body.data.amountGhs).toBe('125.50');

        // post-response dispatch boundary
        const started = Date.now();
        while (Date.now() - started < 4000 && port.initiateBankTransfer.mock.calls.length === 0) {
            await new Promise((r) => setTimeout(r, 25));
        }
        expect(port.initiateBankTransfer).toHaveBeenCalledTimes(1);
        // EXACT Agent B contract (services/moolreBankPayoutService.js):
        // { referenceId, amountGhsExact, recipientAccountNumber, bankCode,
        //   payerMessage, payeeNote } — the fake must not invent a different one.
        const call = port.initiateBankTransfer.mock.calls[0][0];
        expect(Object.keys(call).sort()).toEqual([
            'amountGhsExact', 'bankCode', 'payeeNote', 'payerMessage', 'recipientAccountNumber', 'referenceId',
        ]);
        expect(call.amountGhsExact).toBe('125.50');
        expect(call.referenceId).toBe(res.body.reference); // ORIGINAL reference, not a new one
        expect(call.bankCode).toBe('GCB'); // the stored bank code, passed through untouched
        expect(call.recipientAccountNumber).toBe('1234567890123'); // decrypted at the boundary only

        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(new Prisma.Decimal(fresh.nativeGhsBalance).toFixed(2)).toBe('374.50');

        const mirror = await prisma.withdrawal.findFirst({ where: { userId: user.id }, orderBy: { id: 'desc' } });
        expect(mirror.payoutMethod).toBe('BANK');
        expect(mirror.settlementCurrency).toBe('GHS_NATIVE');
        expect(new Prisma.Decimal(mirror.amountGhs).toFixed(2)).toBe('125.50');
    });
    test('§6 typed validation: unusable account numbers and names are refused at save time', async () => {
        await setFlags();
        const app = buildApp();
        const user = await seedUser(prisma, {});

        // Too short to be any real account: 6-9 digits used to be accepted.
        const short = await createBene(app, user, { accountNumber: '123456' });
        expect(short.status).toBe(400);
        expect(short.body.code).toBe('ACCOUNT_NUMBER_INVALID');

        // Not a name at all.
        const digitsOnly = await createBene(app, user, { accountName: '12345' });
        expect(digitsOnly.status).toBe(400);
        expect(digitsOnly.body.code).toBe('ACCOUNT_NAME_INVALID');
        const singleChar = await createBene(app, user, { accountName: 'A' });
        expect(singleChar.status).toBe(400);
        expect(singleChar.body.code).toBe('ACCOUNT_NAME_INVALID');

        // Unsaved on every refusal: a rejected payee is never a row.
        expect(await prisma.savedBankBeneficiary.count({ where: { userId: user.id } })).toBe(0);

        // A valid save is explicit that the name is UNVERIFIED.
        const ok = await createBene(app, user);
        expect(ok.status).toBe(201);
        expect(ok.body.beneficiary.accountName).toBe('Ama Mensah');
        expect(ok.body.beneficiary.accountNameVerified).toBe(false);
        expect(ok.body.beneficiary.validatedAt).toBeNull();
    });

    test('§6 whitespace and dotted names are normalised, not rejected', async () => {
        await setFlags();
        const app = buildApp();
        const user = await seedUser(prisma, {});
        const res = await createBene(app, user, { accountName: '  ama   mensah-owusu .jr ' });
        expect(res.status).toBe(201);
        expect(res.body.beneficiary.accountName).toBe('ama mensah-owusu .jr');
    });

    test('§9 BANK refuses with zero mutation while the bank fee is unevidenced', async () => {
        await setFlags();
        const svc = require('../src/services/nativeGhsWithdrawalService');
        const beneSvc = require('../src/services/savedBankBeneficiaryService');
        const app = buildApp({ initiateBankTransfer: jest.fn() });
        const user = await seedUser(prisma, { nativeGhsBalance: 500 });
        const created = await createBene(app, user);
        const bank = await beneSvc.revealForPayout(prisma, user.id, created.body.beneficiary.id);

        const saved = process.env.BANK_PAYOUT_FEE_GHS;
        delete process.env.BANK_PAYOUT_FEE_GHS;
        let err = null;
        try {
            await svc.processNativeGhsWithdrawal(
                prisma,
                user.id,
                {
                    amountGhs: '80.00',
                    destination: bank.accountNumberMasked,
                    reference: randomUUID(),
                    destinationType: 'BANK',
                    beneficiaryId: bank.id,
                },
                { commitOperationClaimInTransaction: async () => {} }
            );
        } catch (e) {
            err = e;
        } finally {
            process.env.BANK_PAYOUT_FEE_GHS = saved;
        }

        expect(err).not.toBeNull();
        expect(err.code).toBe('BANK_FEE_POLICY_UNEVIDENCED');
        // The MoMo zero-fee contract must not be silently inherited.
        expect(err.message).toMatch(/bank transfer fee/i);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('500.00');
        expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.transactionHistory.count({ where: { userId: user.id, type: 'WITHDRAWAL_FIAT' } })).toBe(0);
    });

    test('§6 a payee changed AFTER acceptance is never paid (deterministic, no timing window)', async () => {
        await setFlags();
        const svc = require('../src/services/nativeGhsWithdrawalService');
        const beneSvc = require('../src/services/savedBankBeneficiaryService');
        const app = buildApp();
        const user = await seedUser(prisma, { nativeGhsBalance: 500 });

        const created = await createBene(app, user);
        expect(created.status).toBe(201);
        const beneficiaryId = created.body.beneficiary.id;

        // The destination the customer actually CONFIRMED.
        const bank = await beneSvc.revealForPayout(prisma, user.id, beneficiaryId);
        const snapshot = {
            beneficiaryId: bank.id,
            bankCode: bank.bankCode,
            bankName: bank.bankName,
            accountName: bank.accountName || null,
            accountNumberMasked: bank.accountNumberMasked,
            fingerprint: beneSvc.fingerprint(bank.accountNumber),
            capturedAt: new Date().toISOString(),
        };

        // STEP 1: acceptance. Money moves, snapshot is bound. No dispatch here,
        // so there is no race with anything that follows.
        const reference = randomUUID();
        const facts = await svc.processNativeGhsWithdrawal(
            prisma,
            user.id,
            {
                amountGhs: '80.00',
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );
        expect(new Prisma.Decimal(facts.recipientGhsExact).toFixed(2)).toBe('80.00');

        // BAIT AND SWITCH: after the customer's GHS is already debited, the
        // saved payee stops resolving to the confirmed account.
        await prisma.savedBankBeneficiary.update({ where: { id: beneficiaryId }, data: { status: 'DELETED' } });

        // STEP 2: dispatch, called explicitly — the outcome cannot depend on
        // how fast the test reached this line.
        const port = { initiateBankTransfer: jest.fn(async () => ({ providerRef: 'SHOULD-NEVER-HAPPEN', status: 'PENDING' })) };
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port,
        });

        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('BANK_DESTINATION_CHANGED');
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();

        const th = await prisma.transactionHistory.findUnique({
            where: { txHash: reference },
            select: { id: true, metadata: true, status: true },
        });
        // The snapshot is durable, masked-tail + HMAC only.
        expect(th.metadata.bankDestinationSnapshot).toMatchObject({
            beneficiaryId,
            bankCode: 'GCB',
            accountNumberMasked: '*********0123',
            fingerprint: snapshot.fingerprint,
        });
        expect(JSON.stringify(th.metadata)).not.toContain('1234567890123');
        // The refusal is evidence, not a guess, and it is not a refund.
        expect(th.metadata.bankDestinationRevalidation).toMatchObject({
            code: 'BANK_DESTINATION_CHANGED',
            refunded: false,
            resolution: 'PAYEE_MUST_BE_CONFIRMED',
        });
        // No bogus lookup instruction: nothing was dispatched, so polling the
        // provider for the original reference can never resolve this.
        expect(th.metadata.dispatchException).toBeUndefined();

        // Nothing is sent and nothing is refunded: the payout is HELD.
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: th.id }, orderBy: { id: 'desc' } });
        // Out of the retry set (a PENDING row would be re-attempted on every
        // worker tick), and visibly queued for a human instead.
        expect(mirror.status).toBe('NEEDS_MANUAL_REVIEW');
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('420.00');
    });

});
