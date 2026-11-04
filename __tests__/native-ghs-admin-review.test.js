// __tests__/native-ghs-admin-review.test.js
// =============================================================================
// Native-GHS payout parked for operator review — issue #389 (§4.4 / §6).
// Real PostgreSQL.
//
// PROVES the operator path end to end:
//   A. A payee that no longer matches the confirmed destination parks the
//      payout in the review queue WITH durable operator evidence
//      (BANK_DESTINATION_CHANGED @ PRE_DISPATCH), not just metadata — an
//      operator must never see a park with no reason and only ESCALATE.
//   B. The admin queue lists it with that reason.
//   C. REJECT refunds the REAL GHS through the GHS reversal authority: the
//      customer's native balance comes back exactly once, USDC is untouched,
//      and the payout ends FAILED with the mirror REJECTED. (The legacy USDC
//      reversal would "refund" zero and still mark the payout failed.)
// =============================================================================

// The disposable database is an EXPLICIT input, captured before anything else
// touches the connection. This suite contains a table-wide maintenance statement
// (the orphan sweep), so "a test URL exists" is not permission to run: the guard
// in beforeEach re-proves the client is connected to THIS database before the
// statement is executed, and fails closed otherwise.
const TEST_DATABASE_URL = String(process.env.TEST_DATABASE_URL || '').trim();
const hasDb = !!TEST_DATABASE_URL;
const maybe = hasDb ? describe : describe.skip;

if (hasDb) {
    // Bind Prisma's own URL to the explicit test URL BEFORE the client is built:
    // a stray DATABASE_URL pointing at another database must never leak in.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

maybe('native-GHS payout in the operator review queue (real PostgreSQL)', () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let recordReconciliationException;
    let assertDisposableTestDatabase;
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        ({ recordReconciliationException } = require('../services/reconciliationExceptionService'));
        ({ assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard'));
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    // §1 TRACKED FIXTURE SCOPE. The exception table's OPEN rows are unique per
    // (entityType, entityId, reason) and entityId is a bare numeric string with
    // no foreign key. A shared test database can therefore hand a new withdrawal
    // an id an older OPEN row already names, so this suite deletes ONLY the
    // exception rows its own payouts produced — never the shared queue, never a
    // TRUNCATE, never an identity reset.
    const ownedReferences = new Set();

    // Rows this suite created EXPLICITLY, tracked by primary key. A synthetic row
    // written for a foreign payout (the §P1-2 stale-evidence case) carries a
    // reference that belongs to no payout this suite seeded, so a
    // reference-based sweep alone would leave it behind — and because its
    // entityId still names a live Withdrawal, the orphan sweep would not close it
    // either. Ownership is therefore recorded in two ways and cleanup uses both:
    // exact row ids for every explicit write, and references for rows the
    // production path wrote for this suite's own payouts.
    const ownedExceptionIds = new Set();

    /**
     * The production authority for exception writes, plus test ownership: the
     * returned row's id is remembered so cleanup can delete THAT row and nothing
     * else, whatever reference it was written against.
     */
    async function recordOwnedException(args) {
        const row = await recordReconciliationException(prisma, args);
        if (row && row.id) ownedExceptionIds.add(String(row.id));
        return row;
    }

    // §1 ORPHAN SWEEP (disposable test database). An OPEN row whose numeric
    // entityId no longer names a live withdrawal is evidence for a payout that
    // does not exist — it can only shadow a later payout that reuses the id.
    // This CLOSES those rows (status RESOLVED, never deleted) and touches no row
    // that belongs to a still-existing payout, so live evidence is preserved.
    beforeEach(async () => {
        if (!prisma) return;
        // FAIL CLOSED: this UPDATE is table-wide, so it may only run once the
        // client has PROVED it is on TEST_DATABASE_URL (see helpers/testDatabaseGuard).
        await assertDisposableTestDatabase(prisma);
        await prisma.$executeRawUnsafe(
            'UPDATE "ReconciliationException" r SET "status" = \'RESOLVED\', "resolvedAt" = now() '
            + 'WHERE r."status" = \'OPEN\' AND r."entityType" = \'WITHDRAWAL\' '
            + 'AND NOT EXISTS (SELECT 1 FROM "Withdrawal" w WHERE w."id"::text = r."entityId")'
        );
    });

    afterEach(async () => {
        if (!prisma) return;
        const ids = [...ownedExceptionIds];
        const refs = [...ownedReferences];
        ownedExceptionIds.clear();
        ownedReferences.clear();
        // exact rows first: this is what removes synthetic cross-payout evidence
        if (ids.length) {
            await prisma.$executeRawUnsafe(
                'DELETE FROM "ReconciliationException" WHERE "id" = ANY($1::uuid[])',
                ids
            );
        }
        // then anything the production path wrote for this suite's own payouts
        if (refs.length) {
            await prisma.$executeRawUnsafe(
                'DELETE FROM "ReconciliationException" WHERE "entityType" = $1 AND "reference" = ANY($2::text[])',
                'WITHDRAWAL', refs
            );
        }
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
        app.use('/api/admin', require('../routes/adminRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role || 'USER' }, JWT_SECRET, { expiresIn: '1h' });

    // Drive the payout to the parked state deterministically: acceptance binds
    // the snapshot, then the payee stops resolving, then dispatch is called.
    async function seedParkedPayout({ amountGhs = '80.00' } = {}) {
        const svc = require('../src/services/nativeGhsWithdrawalService');
        const beneSvc = require('../src/services/savedBankBeneficiaryService');
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: 'GCB', bankName: 'GCB Bank', accountNumber: '1234567890123', accountName: 'Ama Mensah',
        });
        const bank = await beneSvc.revealForPayout(prisma, user.id, bene.id);
        const snapshot = {
            beneficiaryId: bank.id,
            bankCode: bank.bankCode,
            bankName: bank.bankName,
            accountName: bank.accountName || null,
            accountNumberMasked: bank.accountNumberMasked,
            fingerprint: beneSvc.fingerprint(bank.accountNumber),
            capturedAt: new Date().toISOString(),
        };
        const reference = randomUUID();
        const facts = await svc.processNativeGhsWithdrawal(
            prisma,
            user.id,
            {
                amountGhs,
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );

        await prisma.savedBankBeneficiary.update({ where: { id: bene.id }, data: { status: 'DELETED' } });

        const port = { capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() };
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port,
        });
        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('BANK_DESTINATION_CHANGED');
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        ownedReferences.add(String(reference));
        return { user, reference, canonical, mirror };
    }

    test('§6 park carries durable operator evidence and the queue shows it', async () => {
        await setFlags();
        const { mirror } = await seedParkedPayout();
        expect(mirror.status).toBe('NEEDS_MANUAL_REVIEW');

        const open = await prisma.$queryRawUnsafe(
            'SELECT "reason", "details" FROM "ReconciliationException" WHERE "entityType" = \'WITHDRAWAL\' AND "entityId" = $1 AND "status" = \'OPEN\'',
            String(mirror.id)
        );
        const park = open.find((r) => r.reason === 'BANK_DESTINATION_CHANGED');
        expect(park).toBeTruthy();
        expect(park.details.phase).toBe('PRE_DISPATCH');
        expect(park.details.providerDispatched).toBe(false);

        // And the operator-facing listing surfaces that reason.
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);
        if (list.status === 200) {
            const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
            expect(row).toBeTruthy();
            expect(row.manualReview.reasons.map((r) => r.reason)).toContain('BANK_DESTINATION_CHANGED');
            expect(row.manualReview.reasons.find((r) => r.reason === 'BANK_DESTINATION_CHANGED').phase).toBe('PRE_DISPATCH');
        }
    });

    // §P1-1 RESUME USED TO BE A LIE. Setting the mirror back to PENDING only
    // re-enters a pipeline that selects the row: nothing claims a native-GHS
    // payout (the fiat batch worker excludes it and native GHS dispatches
    // inline at acceptance), and for BANK_DESTINATION_CHANGED a redispatch would
    // pay a payee the customer never confirmed. The operator was told the payout
    // "resumed" while the funds stayed reserved forever.
    test('§P1-1 RESUME is refused where no dispatcher exists, and the row stays in review', async () => {
        await setFlags();
        const { user, mirror } = await seedParkedPayout();
        const before = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const res = await request(app)
            .post(`/api/admin/withdrawals/${mirror.id}/resolve-review`)
            .set('Authorization', `Bearer ${tokenFor(admin)}`)
            .send({ action: 'RESUME', reason: 'operator believes the account is fine now' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('RESUME_NOT_AVAILABLE');
        expect(res.body.data.availableActions).toEqual(['REJECT', 'ESCALATE']);
        expect(res.body.data.blockers.join(' ')).toMatch(/destination changed|dispatcher/i);

        const after = await prisma.withdrawal.findUnique({ where: { id: mirror.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_MANUAL_REVIEW');
        const funds = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        expect(new Prisma.Decimal(funds.nativeGhsBalance).toFixed(2)).toBe(new Prisma.Decimal(before.nativeGhsBalance).toFixed(2));
        expect(new Prisma.Decimal(funds.availableBalance).toFixed(2)).toBe(new Prisma.Decimal(before.availableBalance).toFixed(2));
    });

    // §P1-2 EVIDENCE MUST NAME THIS PAYOUT. entityId has no foreign key, so a
    // stale OPEN row written for a deleted payout can share a numeric id with a
    // fresh one. Grouping by entityId alone put another payout's exception
    // reason (and its resolution options) on this review card.
    test('§P1-2 evidence naming another payout is never shown on this one', async () => {
        await setFlags();
        const { mirror } = await seedParkedPayout();
        // A stale row for a DIFFERENT payout that reuses this numeric id.
        const staleReference = 'ref-of-a-different-payout';
        // A row written for some OTHER payout that happens to share this numeric
        // id. Written through the production authority (upsert on the OPEN
        // uniqueness rule) so a re-run cannot collide with 23505.
        await recordOwnedException({
            entityType: 'WITHDRAWAL',
            entityId: mirror.id,
            reference: staleReference,
            reason: 'PROVIDER_STATUS_UNAVAILABLE',
            details: { phase: 'POST_DISPATCH' },
        });

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);
        if (list.status === 200) {
            const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
            expect(row).toBeTruthy();
            const reasons = row.manualReview.reasons.map((r) => r.reason);
            expect(reasons).toContain('BANK_DESTINATION_CHANGED');
            // The other payout's unknowable anomaly must not appear here.
            expect(reasons).not.toContain('PROVIDER_STATUS_UNAVAILABLE');
            expect(row.manualReview.reasons.every((r) => !r.reference || r.reference !== staleReference)).toBe(true);
        }
    });

    test('§1 bookkeeping failure is visible to operators, allowlisted, and never leaks or attaches elsewhere', async () => {
        await setFlags();
        const { mirror, reference } = await seedParkedPayout();
        const other = await seedParkedPayout();
        // The row shape is produced by the real dispatch path (proven in the
        // initiation suite); this inserts the SAME shape with hostile extras so
        // the read projection's allowlist is what is under test.
        await recordOwnedException({
            entityType: 'WITHDRAWAL',
            entityId: mirror.id,
            reference: String(reference),
            reason: 'PARK_BOOKKEEPING_INCOMPLETE',
            details: {
                phase: 'POST_DISPATCH_BOOKKEEPING',
                decision: 'UNRESOLVED',
                failedSteps: ['OWNERSHIP', 'RAW_SQL_UPDATE', 42],
                recordedSteps: ['PARK_METADATA', 'PROVIDER_EVENT', 'IN_TRANSIT'],
                error: 'connect ECONNREFUSED 10.0.0.1:5432',
                sql: 'UPDATE "TransactionHistory" SET "metadata" = $1',
                providerRaw: { authorization: 'Bearer sk_live_deadbeef' },
                accountNumber: '1234567890123',
            },
        });

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);

        const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
        expect(row).toBeTruthy();
        const evidence = (row.manualReview.reasons || []).find((r) => r.reason === 'PARK_BOOKKEEPING_INCOMPLETE');
        expect(evidence).toBeTruthy();
        // identity: this payout's own canonical reference
        expect(evidence.reference).toBe(String(reference));
        expect(evidence.phase).toBe('POST_DISPATCH_BOOKKEEPING');
        expect(evidence.decision).toBe('UNRESOLVED');
        // allowlist: unknown step names and non-strings are dropped, not echoed
        expect(evidence.failedSteps).toEqual(['OWNERSHIP']);
        expect(evidence.recordedSteps).toEqual(['PARK_METADATA', 'PROVIDER_EVENT', 'IN_TRANSIT']);

        // no leakage of errors, SQL, credentials or customer bank data in THIS
        // payout's evidence (other queued rows are not what this test creates)
        const blob = JSON.stringify(evidence);
        expect(blob).not.toContain('ECONNREFUSED');
        expect(blob).not.toContain('sk_live_deadbeef');
        expect(blob).not.toContain('1234567890123');
        expect(blob).not.toContain('RAW_SQL_UPDATE');

        // an unrelated payout never receives another payout's bookkeeping failure
        const otherRow = (list.body.withdrawals || []).find((w) => w.id === other.mirror.id);
        if (otherRow) {
            expect((otherRow.manualReview.reasons || []).map((r) => r.reason)).not.toContain('PARK_BOOKKEEPING_INCOMPLETE');
        }
    });

    test('§4.4 operator REJECT refunds the real GHS exactly once and touches no USDC', async () => {
        await setFlags();
        const { user, reference, mirror } = await seedParkedPayout();
        const before = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        expect(new Prisma.Decimal(before.nativeGhsBalance).toFixed(2)).toBe('420.00');

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const res = await request(app)
            .post(`/api/admin/withdrawals/${mirror.id}/resolve-review`)
            .set('Authorization', `Bearer ${tokenFor(admin)}`)
            .send({ action: 'REJECT', reason: 'customer re-confirmed a different account' });

        expect(res.status).toBe(200);

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        // The GHS reversal marks the mirror FAILED inside its own transaction
        // (the payout failed and the money came back). The legacy USDC path
        // uses REJECTED; here the authority owns the terminal status and the
        // admin layer must not contradict it.
        const mirrorAfter = await prisma.withdrawal.findUnique({ where: { id: mirror.id } });
        expect(mirrorAfter.status).toBe('FAILED');

        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        // The REAL money comes back: exact GHS, not a zero USDC refund.
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('500.00');
        expect(new Prisma.Decimal(after.availableBalance).toFixed(2)).toBe(new Prisma.Decimal(before.availableBalance).toFixed(2));

        // Refunded once: a second resolve is refused and moves nothing.
        const again = await request(app)
            .post(`/api/admin/withdrawals/${mirror.id}/resolve-review`)
            .set('Authorization', `Bearer ${tokenFor(admin)}`)
            .send({ action: 'REJECT', reason: 'retry' });
        expect(again.status).toBeGreaterThanOrEqual(400);
        const after2 = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after2.nativeGhsBalance).toFixed(2)).toBe('500.00');
    });
    test('§2 a legacy BANK destination never leaves the operator response, and other rails are untouched', async () => {
        await setFlags();
        const LEGACY_BANK_ACCOUNT = '1234567890123';

        // A BANK payout whose stored destination predates masking.
        const legacy = await seedParkedPayout();
        await prisma.withdrawal.update({
            where: { id: legacy.mirror.id },
            data: { destination: LEGACY_BANK_ACCOUNT },
        });
        // A BANK payout that is already masked: the mask must be preserved.
        const alreadyMasked = await seedParkedPayout();
        // A MoMo payout: a phone-number destination is not a bank account.
        const momo = await seedParkedPayout();
        await prisma.withdrawal.update({
            where: { id: momo.mirror.id },
            data: { payoutMethod: 'MOMO', destination: '0244123456' },
        });
        // Hostile exception evidence carrying a raw account number.
        await recordOwnedException({
            entityType: 'WITHDRAWAL',
            entityId: legacy.mirror.id,
            reference: String(legacy.reference),
            reason: 'BANK_DESTINATION_CHANGED',
            details: {
                phase: 'PRE_DISPATCH',
                providerDispatched: false,
                accountNumber: LEGACY_BANK_ACCOUNT,
                sql: 'UPDATE "Withdrawal" SET "destination" = $1',
            },
        });

        const storedMasked = (await prisma.withdrawal.findUnique({ where: { id: alreadyMasked.mirror.id } })).destination;


        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);

        // THE WHOLE RESPONSE, not just manualReview.reasons.
        const responseBlob = JSON.stringify(list.body);
        expect(responseBlob).not.toContain(LEGACY_BANK_ACCOUNT);

        const byId = new Map((list.body.withdrawals || []).map((w) => [w.id, w]));
        const legacyRow = byId.get(legacy.mirror.id);
        expect(legacyRow).toBeTruthy();
        expect(legacyRow.destination).not.toBe(LEGACY_BANK_ACCOUNT);
        // 1234567890123 -> the last four digits survive, the rest is shielded.
        expect(legacyRow.destination).toContain('0123');
        expect(legacyRow.destination).toBe('*********0123');
        expect(legacyRow.destination).toMatch(/^\*+0123$/);

        const maskedRow = byId.get(alreadyMasked.mirror.id);
        expect(maskedRow.destination).toBe(storedMasked);
        expect(maskedRow.destination).toContain('*');

        // MoMo destinations are not bank accounts and must survive verbatim.
        const momoRow = byId.get(momo.mirror.id);
        expect(momoRow.destination).toBe('0244123456');
        expect(momoRow.payoutMethod).toBe('MOMO');

        // The stored rows themselves are untouched: this is display only.
        const legacyStored = await prisma.withdrawal.findUnique({ where: { id: legacy.mirror.id } });
        expect(legacyStored.destination).toBe(LEGACY_BANK_ACCOUNT);
    });
    test('§1b the orphan sweep refuses to run unless the target is provably the disposable test database', async () => {
        const { assertDisposableTestDatabase: guard } = require('./helpers/testDatabaseGuard');
        const TEST_URL = 'postgres://postgres:postgres@localhost:5432/azm_iso?schema=public';
        const SID = '7686515198152565070';
        // The exhaustive IPv4 / IPv6 / CIDR / identity matrix lives in
        // __tests__/test-database-guard.test.js (run as its own step in the
        // financial-durability lane). This test proves the guard as this suite
        // wires it: refusals happen before the caller's statement, and the
        // positive path runs here for real.
        const seams = (over = {}) => ({
            testUrl: TEST_URL, databaseUrl: TEST_URL, nodeEnv: 'test',
            expectedAddress: '', containerId: '', localDataDir: '/var/lib/postgresql/15/main', githubActions: false,
            probeLocalCluster: () => ({ systemIdentifier: SID, dataDirectory: '/var/lib/postgresql/15/main', postmasterPid: 422, port: '5432' }),
            ...over,
        });

        function stubClient({ database = 'azm_iso', serverAddress = '127.0.0.1/32', systemIdentifier = SID, dataDirectory = '/var/lib/postgresql/15/main' } = {}) {
            const statements = [];
            return {
                statements,
                $queryRawUnsafe: async (sql) => {
                    statements.push(sql);
                    return [{ database, server_address: serverAddress, system_identifier: systemIdentifier, data_directory: dataDirectory, port: '5432' }];
                },
                $executeRawUnsafe: async (sql) => { statements.push(sql); },
            };
        }
        const mutations = (stub) => stub.statements.filter((sql) => /^\s*(UPDATE|DELETE|TRUNCATE|INSERT)/i.test(sql));

        // (a) no explicit test database at all
        await expect(guard(stubClient(), seams({ testUrl: '' }))).rejects.toThrow(/TEST_DATABASE_URL is not set/);

        // (b) not the test environment
        await expect(guard(stubClient(), seams({ nodeEnv: 'production' }))).rejects.toThrow(/NODE_ENV is "production", not "test"/);

        // (c) bound elsewhere — the error must not leak that URL's credentials
        const credentialled = 'postgres://ci_runner:hunter2-should-never-leak@db.prod.example.com:5432/azm_test?schema=public';
        let boundMismatch;
        try {
            await guard(stubClient(), seams({ databaseUrl: credentialled }));
            throw new Error('guard allowed a bound-URL mismatch');
        } catch (err) { boundMismatch = err; }
        expect(boundMismatch.message).toMatch(/is not the explicit test database/);
        expect(boundMismatch.message).not.toContain('hunter2-should-never-leak');
        expect(boundMismatch.message).not.toContain('ci_runner');
        expect(boundMismatch.message).toContain('db.prod.example.com:5432/azm_test');

        // (d) the URL matched but the CONNECTION is a different database
        const wrongTarget = stubClient({ database: 'azm_production' });
        await expect(guard(wrongTarget, seams()))
            .rejects.toThrow(/connected to database "azm_production", but the disposable test database is "azm_iso"/);
        expect(mutations(wrongTarget)).toHaveLength(0);

        // (e) unreadable target — and the message must not echo it back
        const opaque = 'postgres://svc:sekret@[::bad/db';
        let unreadable;
        try {
            await guard(stubClient(), seams({ testUrl: opaque, databaseUrl: opaque }));
            throw new Error('guard allowed an unreadable URL');
        } catch (err) { unreadable = err; }
        expect(unreadable.message).toMatch(/does not parse into a host and a database name/);
        expect(unreadable.message).not.toContain('sekret');

        // (f) a REMOTE host with the exact expected database name, and the server
        //     agreeing on that name, is still refused with ZERO queries issued.
        const remoteUrl = 'postgres://postgres:postgres@azm-prod-db.example.com:5432/azm_iso?schema=public';
        const remote = stubClient();
        await expect(guard(remote, seams({ testUrl: remoteUrl, databaseUrl: remoteUrl })))
            .rejects.toThrow(/host "azm-prod-db\.example\.com".*is not a loopback address/);
        expect(remote.statements).toHaveLength(0);

        // (g) an ssh -L tunnel: loopback URL, loopback report, WRONG cluster.
        const tunnelled = stubClient({ systemIdentifier: '1111111111111111111' });
        await expect(guard(tunnelled, seams())).rejects.toThrow(/A forwarded, tunnelled or proxied server is not a disposable local target/);
        expect(mutations(tunnelled)).toHaveLength(0);

        // (h) a locally supplied expectation is a claim, not identity.
        await expect(guard(stubClient({ serverAddress: '203.0.113.9/32' }), seams({ expectedAddress: '203.0.113.9' })))
            .rejects.toThrow(/is not an independently verified identity/);

        // (i) the CI path needs a verified container, not a matching number.
        const ciBase = {
            githubActions: true, expectedAddress: '172.18.0.2', containerId: '2f206542ec5f',
            inspectContainerIdentity: ({ address }) => ({ containerId: '2f206542ec5f', containerAddress: address, image: 'postgres:16' }),
        };
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), seams(ciBase)))
            .resolves.toMatchObject({ identity: 'ci-container-identity' });
        await expect(guard(stubClient({ serverAddress: '172.18.0.3/32' }), seams(ciBase)))
            .rejects.toThrow(/Identity mismatch/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), seams({ ...ciBase, expectedAddress: '172.18.0.2/32' })))
            .rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS/);

        // (j) the positive LOCAL path: this suite's own wiring, against the real
        //     database, proving the cluster this machine owns.
        const good = stubClient();
        const result = await guard(good, { probeLocalCluster: require('./helpers/testDatabaseGuard').probeLocalCluster });
        expect(result.identity).toBe('local-cluster-identity');
        expect(result.systemIdentifier).toMatch(/^\d+$/);
        expect(good.statements).toHaveLength(1);
        expect(mutations(good)).toHaveLength(0);
    });
});
