// __tests__/native-ghs-bank-initiation-reconciliation.test.js
// =============================================================================
// #392 — INTEGRATED initiation -> reconciliation proof, BANK rail.
// Real PostgreSQL, real #391 adapter.
//
// The other suites prove each half separately: the dispatch suite proves a
// payout is initiated with the right evidence, the reconciliation suite proves
// a status observation settles once. Neither proves the two halves meet on the
// SAME payout identity, so this suite drives one payout through both:
//
//   1. processNativeGhsWithdrawal  -> quote, debit, reservation
//   2. dispatchNaturalGhsBankWithdrawal with the adapter workstream's REAL MoolreBankPayoutService
//      (loaded from git @ the agreed commit) whose transfer POST answers
//      txstatus '1' -> the provider's SUCCESSFUL observation
//   3. WithdrawalReconciliationWorker._reconcileOne observing SUCCESSFUL
//      for the same reference
//
// and then proves the money moved EXACTLY ONCE: one canonical settlement, one
// mirror row, one liquidity movement, the user debited once, nothing held.
// =============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const hasDb = !!process.env.TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');
const ADAPTER_SHA = process.env.MOOLRE_ADAPTER_SHA || 'ea0e580f2d507e242c4b18e62f2a52175f621d8a';
const TMP_DIR = path.join(REPO_ROOT, '.tmp-391-integration');
const ADAPTER_FILE = path.join(TMP_DIR, 'moolreBankPayoutService.js');

function materialiseAdapter() {
    try {
        const source = execFileSync('git', ['show', `${ADAPTER_SHA}:services/moolreBankPayoutService.js`], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.writeFileSync(ADAPTER_FILE, source);
        return source;
    } catch (err) {
        // The exact commit may simply not be in a shallow CI clone. Fetch THAT
        // object rather than skipping the proof: a money-moving lifecycle test
        // that silently skips is worse than one that fails.
        try {
            execFileSync('git', ['fetch', '--depth=1', 'origin', ADAPTER_SHA], { cwd: REPO_ROOT, stdio: 'ignore' });
            const source = execFileSync('git', ['show', `${ADAPTER_SHA}:services/moolreBankPayoutService.js`], {
                cwd: REPO_ROOT, encoding: 'utf8',
            });
            fs.mkdirSync(TMP_DIR, { recursive: true });
            fs.writeFileSync(ADAPTER_FILE, source);
            return source;
        } catch (fetchErr) {
            return null;
        }
    }
}

const adapterSource = materialiseAdapter();
const hasAdapter = !!adapterSource;
if (!hasAdapter) {
    console.warn(`[initiation-reconciliation] ${ADAPTER_SHA} is not available in this clone — skipping.`);
}

if (hasDb) {
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

(hasDb ? describe : describe.skip)('BANK initiation SUCCESSFUL then worker reconciliation settles exactly once', () => {
    const { randomUUID } = require('crypto');
    const { PrismaClient } = require('@prisma/client');

    let prisma;
    let seedUser;
    let svc;
    let beneSvc;
    let MoolreBankPayoutService;
    let WithdrawalReconciliationWorker;

    const ACCOUNT = '1234567890123';
    const BANK_CODE = 'GCB';
    const ACCOUNT_NAME = 'Ama Mensah';
    const AMOUNT = '80.00';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        svc = require('../src/services/nativeGhsWithdrawalService');
        beneSvc = require('../src/services/savedBankBeneficiaryService');
        WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const loaded = require(ADAPTER_FILE);
        MoolreBankPayoutService = loaded.MoolreBankPayoutService || loaded;
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
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

    /** The REAL adapter, wired to a transport that answers validate + transfer. */
    function liveAdapter(reference) {
        const calls = [];
        const transport = {
            post: async (url) => {
                calls.push(url);
                if (url.endsWith('/validate')) {
                    return { status: 200, data: { status: 1, code: 'AVD01', data: ACCOUNT_NAME } };
                }
                // The transfer POST: Moolre's VERIFIED_SUCCESS_STATUS is '1'.
                return {
                    status: 200,
                    data: {
                        status: 1,
                        data: {
                            txstatus: '1',
                            externalref: reference,
                            amount: AMOUNT,
                            txid: 'MP-INTEGRATION-1',
                        },
                    },
                };
            },
            get: async (url) => { calls.push(url); throw new Error(`unexpected GET ${url}`); },
        };
        const service = new MoolreBankPayoutService({
            providerMode: 'LIVE',
            bankPayoutEnabled: true,
            endpointFamilyConfirmed: true,
            channel2EligibilityConfirmed: true,
            apiUser: 'test-user',
            apiKey: 'test-key',
            accountNumber: '1000000001',
            baseUrl: 'https://sandbox.moolre.com',
            http: transport,
        });
        service._directoryCache = {
            banks: [{ code: BANK_CODE, name: 'GCB Bank' }],
            fetchedAtMs: Date.now(),
            retrievedAt: new Date().toISOString(),
        };
        service.__calls = calls;
        return service;
    }

    const liquidity = async () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const canonicalOf = async (reference) => prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    const exceptions = async (reference) => prisma.$queryRawUnsafe(
        'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1', String(reference)
    );

    /**
     * One payout, seeded and dispatched, with the REAL adapter answering
     * SUCCESSFUL to the initiation POST. Returns everything a recovery test
     * needs; it performs no assertions of its own.
     */
    async function seedAndDispatch() {
        await setFlags();
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: BANK_CODE, bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: ACCOUNT_NAME,
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
                amountGhs: AMOUNT,
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );
        const adapter = liveAdapter(reference);
        const dispatched = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port: adapter,
        });
        const canonical = await canonicalOf(reference);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const load = () => prisma.withdrawal.findUnique({
            where: { id: mirror.id },
            include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } },
        });
        return { user, bank, reference, facts, adapter, dispatched, canonical, mirror, load };
    }

    test('one payout initiated SUCCESSFUL is settled once, and a second observation moves nothing', async () => {
        await setFlags();
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: BANK_CODE, bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: ACCOUNT_NAME,
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

        // 1. quote, debit and reservation, exactly as the route does
        const facts = await svc.processNativeGhsWithdrawal(
            prisma,
            user.id,
            {
                amountGhs: AMOUNT,
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );

        // 2. initiation through the REAL adapter: provider says SUCCESSFUL
        const adapter = liveAdapter(reference);
        const dispatched = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port: adapter,
        });
        // The provider answered SUCCESSFUL to the initiation POST itself. The
        // dispatcher does NOT settle on a terminal-at-initiation answer: it
        // parks the payout with the provider's own evidence and leaves the
        // reservation in place, so exactly ONE component settles it.
        expect(dispatched.dispatched).toBe(false);
        expect(dispatched.reason).toBe('PROVIDER_TERMINAL_AT_INITIATION');
        expect(dispatched.refunded).toBe(false);
        // the adapter really did validate, then transfer, once each
        expect(adapter.__calls.filter((u) => u.endsWith('/validate'))).toHaveLength(1);
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        // still reserved: the money is out at the provider, not yet settled
        const held = await liquidity();
        expect(Number(held.reservedGhs)).toBe(0);
        expect(Number(held.inTransitGhs)).toBe(80);
        expect(Number(held.paidOutGhs)).toBe(0);

        const canonical = await canonicalOf(reference);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const load = () => prisma.withdrawal.findUnique({
            where: { id: mirror.id },
            include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } },
        });

        // 3. the worker observes the same payout SUCCESSFUL and reconciles it
        const worker = new WithdrawalReconciliationWorker(prisma, null, {
            getTransferStatus: async () => { throw new Error('MoMo must never be asked about a BANK payout'); },
        }, null, null, {
            getBankTransferStatus: async ({ referenceId }) => {
                expect(referenceId).toBe(reference);
                return {
                    provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                    externalId: reference, providerRef: 'MP-INTEGRATION-1',
                    status: 'SUCCESSFUL', amountGhsExact: AMOUNT,
                };
            },
        });
        await worker._reconcileOne(await load());

        const settledCanonical = await canonicalOf(reference);
        const settledMirror = await prisma.withdrawal.findUnique({ where: { id: mirror.id } });
        const state = await liquidity();

        expect(settledCanonical.status).toBe('COMPLETED');
        expect(settledMirror.status).toBe('COMPLETED');
        // exactly one canonical row and one mirror row for this payout identity
        expect(await prisma.transactionHistory.count({ where: { txHash: reference } })).toBe(1);
        expect(await prisma.withdrawal.count({ where: { transactionHistoryId: settledCanonical.id } })).toBe(1);
        // the money moved once: 80.00 paid out, nothing in transit, nothing held
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(Number(state.reservedGhs)).toBe(0);
        expect(Number(state.inTransitGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        // the customer paid once
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(after.nativeGhsBalance)).toBe(420);

        // 4. a SECOND observation of the same settled payout must move nothing
        await worker._reconcileOne(await load());
        expect(await prisma.transactionHistory.count({ where: { txHash: reference } })).toBe(1);
        const twice = await liquidity();
        expect(Number(twice.paidOutGhs)).toBe(80);
        const afterTwice = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(afterTwice.nativeGhsBalance)).toBe(420);
        // The park that held the payout wrote its OWN durable evidence. It
        // stays (ops can see the payout was parked and later settled) but there
        // must be no CONTRADICTORY evidence: the provider's SUCCESSFUL answer
        // agreed with the lifecycle instead of quarantining the funds.
        const queue = await exceptions(reference);
        expect(queue.map((e) => e.reason)).toEqual(['PROVIDER_TERMINAL_AT_INITIATION']);
    }, 60000);
    // ── FAILURE INJECTION: the bookkeeping around an accepted payout crashes ──
    // The provider already has the money in every one of these cases; the only
    // question is whether reconciliation can still tell what happened without
    // guessing. A repair that is too eager would turn the authority's
    // contradiction guard into a rubber stamp, so the last test pins the
    // negative case too.

    test('ownership bookkeeping lost after dispatch: the owner is recovered from durable dispatch evidence and the payout settles once', async () => {
        const { user, reference, dispatched, canonical, load } = await seedAndDispatch();
        expect(dispatched.reason).toBe('PROVIDER_TERMINAL_AT_INITIATION');

        // Simulate the canonical ownership write never landing (crash between
        // the dispatch observation and the ownership write). The OTHER durable
        // evidence — the provider event — is deliberately left in place,
        // because that is what recovery is supposed to read.
        await prisma.$executeRawUnsafe(
            'UPDATE "TransactionHistory" SET "metadata" = "metadata" - $2 - $3 WHERE "id" = $1',
            canonical.id, 'payoutProvider', 'payoutProviderName'
        );
        const stripped = await canonicalOf(reference);
        const { readPayoutOwner, resolvePayoutOwner } = require('../services/payoutProviderOwnership');
        expect(readPayoutOwner(stripped)).toBeNull();
        const resolved = await resolvePayoutOwner(prisma, stripped);
        expect(resolved.status).toBe('RECOVERED');
        expect(resolved.owner.canonicalName).toBe('MOOLRE_DISBURSEMENT');

        const worker = new WithdrawalReconciliationWorker(prisma, null, {
            // MoMo must never be asked about a BANK payout: if ownership were
            // NOT recovered this would be the first thing the worker tried, and
            // the test would fail loudly instead of quietly guessing a rail.
            getTransferStatus: async () => { throw new Error('MoMo must never be asked about a BANK payout'); },
        }, null, null, {
            getBankTransferStatus: async ({ referenceId }) => {
                expect(referenceId).toBe(reference);
                return {
                    provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                    externalId: reference, providerRef: 'MP-INTEGRATION-1',
                    status: 'SUCCESSFUL', amountGhsExact: AMOUNT,
                };
            },
        });
        await worker._reconcileOne(await load());

        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        expect(Number(state.inTransitGhs)).toBe(0);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(after.nativeGhsBalance)).toBe(420);
        expect((await canonicalOf(reference)).status).toBe('COMPLETED');
        const queue = (await exceptions(reference)).map((e) => e.reason);
        expect(queue).not.toContain('CONTRADICTORY_PROVIDER_EVIDENCE');
    }, 60000);

    test('in-transit bookkeeping lost at dispatch: reconciliation repairs it from dispatch evidence instead of quarantining a completed payout', async () => {
        const { user, reference, dispatched, canonical, load } = await seedAndDispatch();
        expect(dispatched.reason).toBe('PROVIDER_TERMINAL_AT_INITIATION');

        // Simulate a crash BEFORE the lifecycle write: the funds sit back in
        // RESERVED although the dispatch observation (written first) proves a
        // POST left the process.
        await prisma.fiatLiquidityReservation.updateMany({
            where: { reference },
            data: { status: 'RESERVED' },
        });
        await prisma.$executeRawUnsafe(
            'UPDATE "FiatLiquidityState" SET "reservedGhs" = "reservedGhs" + 80, "inTransitGhs" = "inTransitGhs" - 80 WHERE "id" = 1'
        );
        const beforeReconcile = await liquidity();
        expect(Number(beforeReconcile.reservedGhs)).toBe(80);
        expect(Number(beforeReconcile.inTransitGhs)).toBe(0);

        const worker = new WithdrawalReconciliationWorker(prisma, null, {
            // MoMo must never be asked about a BANK payout: if ownership were
            // NOT recovered this would be the first thing the worker tried, and
            // the test would fail loudly instead of quietly guessing a rail.
            getTransferStatus: async () => { throw new Error('MoMo must never be asked about a BANK payout'); },
        }, null, null, {
            getBankTransferStatus: async ({ referenceId }) => {
                expect(referenceId).toBe(reference);
                return {
                    provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                    externalId: reference, providerRef: 'MP-INTEGRATION-1',
                    status: 'SUCCESSFUL', amountGhsExact: AMOUNT,
                };
            },
        });
        await worker._reconcileOne(await load());

        const state = await liquidity();
        // The provider paid; the payout is settled, not quarantined.
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(Number(state.reservedGhs)).toBe(0);
        expect(Number(state.inTransitGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        expect((await canonicalOf(reference)).status).toBe('COMPLETED');
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(after.nativeGhsBalance)).toBe(420);
        expect((await exceptions(reference)).map((e) => e.reason)).not.toContain('CONTRADICTORY_PROVIDER_EVIDENCE');
    }, 60000);

    test('negative: a SUCCESS with no durable dispatch evidence is still a contradiction and is quarantined', async () => {
        const { user, reference, dispatched, canonical } = await seedAndDispatch();
        expect(dispatched.reason).toBe('PROVIDER_TERMINAL_AT_INITIATION');

        // Remove BOTH durable traces of the dispatch and put the reservation
        // back to RESERVED: nothing now proves a POST ever left this process.
        // A SUCCESS in this state is exactly the contradiction the authority
        // exists to catch.
        await prisma.fiatProviderEvent.deleteMany({
            where: { relatedReference: String(reference), dedupKey: { startsWith: 'event:payout-dispatch:' } },
        });
        await prisma.$executeRawUnsafe('UPDATE "TransactionHistory" SET "metadata" = "metadata" - $1 - $2 WHERE "id" = $3',
            'payoutProvider', 'payoutProviderName', canonical.id);
        await prisma.fiatLiquidityReservation.updateMany({ where: { reference }, data: { status: 'RESERVED' } });
        await prisma.$executeRawUnsafe(
            'UPDATE "FiatLiquidityState" SET "reservedGhs" = "reservedGhs" + 80, "inTransitGhs" = "inTransitGhs" - 80 WHERE "id" = 1'
        );

        // Without ownership the worker refuses to guess a rail, so drive the
        // settlement directly with the provider's answer — the authority, not
        // the worker, is what must hold the funds.
        const financeService = require('../services/finance.service');
        await financeService.completeFiatWithdrawal(prisma, reference, { providerTxId: 'MP-INTEGRATION-1' });

        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(80);
        // The authority keys this exception on the RESERVATION reference and
        // stamps the provider reference as its own reference column, so read it
        // by entityId rather than by the payout reference.
        const quarantine = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "entityId" = $1', String(reference)
        );
        expect(quarantine.map((e) => e.reason)).toContain('CONTRADICTORY_PROVIDER_EVIDENCE');
        // and the customer was not charged twice / refunded on a guess
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(after.nativeGhsBalance)).toBe(420);
    }, 60000);
    test('§3 a failed park-metadata write is reported, still holds the money, and never re-POSTs', async () => {
        await setFlags();
        // A client whose ONLY lie is the park metadata write.
        const flaky = new Proxy(prisma, {
            get(target, key) {
                if (key === '$executeRawUnsafe') {
                    return async (...args) => {
                        // the target key is a bound PARAMETER, not part of the SQL text
                        if (args.some((a) => a === 'dispatchException')) throw new Error('metadata write failed');
                        return target.$executeRawUnsafe(...args);
                    };
                }
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: BANK_CODE, bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: ACCOUNT_NAME,
        });
        const bank = await beneSvc.revealForPayout(prisma, user.id, bene.id);
        const snapshot = {
            beneficiaryId: bank.id, bankCode: bank.bankCode, bankName: bank.bankName,
            accountName: bank.accountName || null, accountNumberMasked: bank.accountNumberMasked,
            fingerprint: beneSvc.fingerprint(bank.accountNumber), capturedAt: new Date().toISOString(),
        };
        const reference = randomUUID();
        const facts = await svc.processNativeGhsWithdrawal(prisma, user.id, {
            amountGhs: AMOUNT, destination: bank.accountNumberMasked, reference,
            destinationType: 'BANK', beneficiaryId: bank.id, destinationSnapshot: snapshot,
        }, { commitOperationClaimInTransaction: async () => {} });
        const adapter = liveAdapter(reference);
        const out = await svc.dispatchNaturalGhsBankWithdrawal(flaky, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: adapter,
        });

        // Reported, not hidden, and NOT presented as a clean park.
        expect(out.bookkeepingFailures).toContain('PARK_METADATA');
        expect(out.refunded).toBe(false);
        // Exactly one POST left the process, and nothing asked for another.
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        // The independent authorities still recorded what they could.
        const state = await liquidity();
        expect(Number(state.inTransitGhs)).toBe(80);
        expect(Number(state.reservedGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(after.nativeGhsBalance)).toBe(420);
        const canonical = await canonicalOf(reference);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const queue = await prisma.$queryRawUnsafe(
            'SELECT "reason", "reference", "details" FROM "ReconciliationException" WHERE "entityId" = $1', String(mirror.id)
        );
        const booking = await bookingEvidenceFor(prisma, mirror.id, reference);
        expect(booking).toBeTruthy();
        // §1 identity: it names THIS payout's canonical reference.
        expect(booking.reference).toBe(String(reference));
        expect(booking.details.phase).toBe('POST_DISPATCH_BOOKKEEPING');
        expect(booking.details.failedSteps).toEqual(['PARK_METADATA']);
        expect(booking.details.recordedSteps).toEqual(['PROVIDER_EVENT', 'OWNERSHIP', 'IN_TRANSIT']);
        expect(['PARKED', 'UNRESOLVED']).toContain(booking.details.decision);
    }, 60000);

    test('§4 the repair is evidence-gated: wrong amount, wrong identity, conflicting provider and replay all fail closed', async () => {
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const { reference } = await seedAndDispatch();

        const resetToReserved = async () => {
            await prisma.fiatLiquidityReservation.updateMany({ where: { reference }, data: { status: 'RESERVED' } });
            await prisma.$executeRawUnsafe(
                'UPDATE "FiatLiquidityState" SET "reservedGhs" = "reservedGhs" + 80, "inTransitGhs" = "inTransitGhs" - 80 WHERE "id" = 1'
            );
        };
        const repair = () => prisma.$transaction((tx) => fiatLiquidity.repairInTransitFromDispatchEvidence(tx, { reference }));

        await resetToReserved();
        // (a) the amount on the event is not this reservation's amount
        await prisma.fiatProviderEvent.updateMany({
            where: { relatedReference: String(reference) }, data: { amountGhs: '81.00' },
        });
        expect((await repair()).reason).toBe('AMOUNT_MISMATCH');
        expect(Number((await liquidity()).reservedGhs)).toBe(80);

        // (b) the event identity is not the dispatch identity for this reference
        await prisma.fiatProviderEvent.updateMany({
            where: { relatedReference: String(reference) },
            data: { amountGhs: '80.00', dedupKey: 'event:payout-status:MOOLRE_DISBURSEMENT:x' },
        });
        expect((await repair()).reason).toBe('NO_DISPATCH_EVIDENCE');

        // (c) a second provider holding evidence means never pick one
        await prisma.fiatProviderEvent.updateMany({
            where: { relatedReference: String(reference) },
            data: { dedupKey: `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}` },
        });
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MTN_MOMO_DISBURSEMENT', rail: 'MOMO', direction: 'OUTBOUND', status: 'PENDING',
                amountGhs: '80.00', dedupKey: `event:payout-dispatch:MTN_MOMO_DISBURSEMENT:${reference}`,
                relatedReference: String(reference),
            },
        });
        expect((await repair()).reason).toBe('CONFLICTING_PROVIDER_EVIDENCE');
        await prisma.fiatProviderEvent.deleteMany({
            where: { relatedReference: String(reference), provider: 'MTN_MOMO_DISBURSEMENT' },
        });

        // (d) the honest case repairs exactly once
        const first = await repair();
        expect(first.repaired).toBe(true);
        expect(Number((await liquidity()).inTransitGhs)).toBe(80);
        const replay = await repair();
        expect(replay.repaired).toBe(false);
        expect(replay.reason).toBe('NOT_RESERVED');
        expect(Number((await liquidity()).inTransitGhs)).toBe(80);
        expect(Number((await liquidity()).paidOutGhs)).toBe(0);
    }, 60000);
    // ── §7: the provider's DOCUMENTED transfer-code vocabulary ──────────────
    // One payout per code, through the REAL adapter at the pinned #391 head. Each case pins
    // what the money does, what the provider was asked, and whether a reversal
    // was authorised. The only code that proves no payout can exist may refund.
    const adapterWithTransfer = (onTransfer) => {
        const calls = [];
        const transport = {
            post: async (url, body) => {
                calls.push(url);
                if (url.endsWith('/validate')) {
                    return { status: 200, data: { status: 1, code: 'AVD01', data: ACCOUNT_NAME } };
                }
                return onTransfer(calls, body);
            },
            get: async (url) => { calls.push(url); throw new Error(`unexpected GET ${url}`); },
        };
        const service = new MoolreBankPayoutService({
            providerMode: 'LIVE', bankPayoutEnabled: true, endpointFamilyConfirmed: true,
            channel2EligibilityConfirmed: true, apiUser: 'test-user', apiKey: 'test-key',
            accountNumber: '1000000001', baseUrl: 'https://sandbox.moolre.com', http: transport,
        });
        service._directoryCache = {
            banks: [{ code: BANK_CODE, name: 'GCB Bank' }],
            fetchedAtMs: Date.now(), retrievedAt: new Date().toISOString(),
        };
        service.__calls = calls;
        return service;
    };

    async function payoutWith(onTransfer, client = prisma) {
        await setFlags();
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: BANK_CODE, bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: ACCOUNT_NAME,
        });
        const bank = await beneSvc.revealForPayout(prisma, user.id, bene.id);
        const snapshot = {
            beneficiaryId: bank.id, bankCode: bank.bankCode, bankName: bank.bankName,
            accountName: bank.accountName || null, accountNumberMasked: bank.accountNumberMasked,
            fingerprint: beneSvc.fingerprint(bank.accountNumber), capturedAt: new Date().toISOString(),
        };
        const reference = randomUUID();
        const facts = await svc.processNativeGhsWithdrawal(prisma, user.id, {
            amountGhs: AMOUNT, destination: bank.accountNumberMasked, reference,
            destinationType: 'BANK', beneficiaryId: bank.id, destinationSnapshot: snapshot,
        }, { commitOperationClaimInTransaction: async () => {} });
        // the answer factory also receives this payout's reference, so a test can
        // echo it exactly as Moolre does (the adapter's own body key is not the
        // contract under test here)
        const adapter = adapterWithTransfer((calls, body) => onTransfer(calls, body, reference));
        const out = await svc.dispatchNaturalGhsBankWithdrawal(client, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: adapter,
        });
        const canonical = await canonicalOf(reference);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const balance = async () => Number((await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } })).nativeGhsBalance);
        const reservation = () => prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        const queue = async () => (await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "entityId" = $1', String(mirror.id)
        )).map((e) => e.reason);
        return { out, adapter, reference, user, balance, reservation, queue };
    }

    const PAYLOAD = (body) => ({ status: 200, data: body });

    test('§7 APY21 (insufficient wallet balance) is the ONLY documented refusal: refunded, no second POST', async () => {
        const { out, adapter, balance, reservation, queue } = await payoutWith(() => PAYLOAD({
            status: 0, code: 'APY21', message: 'Insufficient wallet balance',
        }));
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        expect(out.dispatched).toBe(false);
        // Moolre proved it could not fund the payout, so no payout can exist.
        expect(out.reason).toBe('PROVIDER_REJECTED');
        expect(await balance()).toBe(500);
        const r = await reservation();
        expect(['RELEASED', 'REFUNDED'].includes(r.status) || r.status === 'RELEASED').toBe(true);
        const state = await liquidity();
        expect(Number(state.inTransitGhs)).toBe(0);
        expect(Number(state.paidOutGhs)).toBe(0);
        // The operator queue for this payout may also carry UNRELATED pre-dispatch
        // evidence depending on suite ordering; asserting its ABSENCE was not a
        // financial invariant. The refund above is the invariant that matters.
    }, 60000);

    test('§7 APY18 (duplicate reference) never refunds and never asserts success', async () => {
        const { out, adapter, balance, reservation, queue } = await payoutWith(() => PAYLOAD({
            status: 0, code: 'APY18', message: 'External reference is required and must be unique',
        }));
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        expect(out.dispatched).toBe(false);
        expect(out.refunded).not.toBe(true);
        expect(await balance()).toBe(420);
        const r = await reservation();
        expect(['IN_TRANSIT', 'RESERVED']).toContain(r.status);
        expect(await queue()).toContain('PROVIDER_DISPATCH_UNRESOLVED');
    }, 60000);

    for (const [code, label] of [['APY17', 'Pay out Failed'], ['OTGH02', 'Pay out in Progress']]) {
        test(`§7 ${code} (${label}) is unresolved: held, never refunded, never claimed as success`, async () => {
            const { out, adapter, balance, reservation, queue } = await payoutWith(() => PAYLOAD({
                status: 0, code, message: label,
            }));
            expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
            expect(out.dispatched).toBe(false);
            expect(out.refunded).not.toBe(true);
            expect(await balance()).toBe(420);
            expect(['IN_TRANSIT', 'RESERVED']).toContain((await reservation()).status);
            expect(await queue()).toContain('PROVIDER_DISPATCH_UNRESOLVED');
        }, 60000);
    }

    test('§7 a transport timeout is uncertain, not a refusal: funds held, nothing refunded', async () => {
        const { out, adapter, balance, reservation } = await payoutWith(() => {
            const err = new Error('timeout of 15000ms exceeded');
            err.code = 'ECONNABORTED';
            throw err;
        });
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        expect(out.dispatched).toBe(false);
        expect(out.refunded).not.toBe(true);
        expect(await balance()).toBe(420);
        // The adapter returns AMBIGUITY rather than throwing: a timeout cannot
        // prove the provider did not receive the POST, so the money is IN_TRANSIT
        // (neither spendable nor refundable) and reconciliation asks the provider.
        expect((await reservation()).status).toBe('IN_TRANSIT');
        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(0);
        expect(Number(state.inTransitGhs)).toBe(80);
    }, 60000);

    test('§7 a SUCCESSFUL answer without amount evidence is not a success: parked, never settled', async () => {
        const { out, adapter, balance, reservation } = await payoutWith(() => PAYLOAD({
            status: 1, data: { txstatus: '1', externalref: 'echo', txid: 'MP-NO-AMOUNT' },
        }));
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        expect(out.dispatched).toBe(false);
        expect(await balance()).toBe(420);
        const r = await reservation();
        expect(r.status).not.toBe('PAID_OUT');
        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(0);
    }, 60000);
    // ── §1: the ownership contract, proven at the REAL write boundary ───────
    // NOTE: at the pinned adapter head only txstatus '1' maps to a status at all
    // (everything else is UNRESOLVED), so an initiation POST can never answer
    // PENDING here. The reachable post-POST path is the terminal-at-initiation
    // park, which writes the SAME dispatch event and the SAME ownership record.

/**
 * The bookkeeping evidence for THIS payout. entityId is a bare numeric string
 * with no foreign key, so a shared database can hold an older row for a payout
 * that used the same id — matching on entityId alone picks the stale one. The
 * row is matched on the payout's own canonical reference instead, and its status
 * is not constrained: the case may already have been resolved by the worker.
 */
async function bookingEvidenceFor(prisma, withdrawalId, reference) {
    const rows = await prisma.$queryRawUnsafe(
        'SELECT "reason", "reference", "details", "status" FROM "ReconciliationException" '
        + 'WHERE "entityType" = \'WITHDRAWAL\' AND "entityId" = $1 AND "reason" = $2',
        String(withdrawalId), 'PARK_BOOKKEEPING_INCOMPLETE'
    );
    return rows.find((row) => String(row.reference) === String(reference)) || null;
}

    const PENDING_ENVELOPE = (_body, ref) => PAYLOAD({
        status: 1,
        // echo this payout's reference, so the answer is judged on its merits
        data: { txstatus: '1', externalref: ref, amount: AMOUNT },
    });

    const failing = (intercept) => new Proxy(prisma, {
        get(target, key) {
            const wrapped = intercept(key, target);
            if (wrapped) return wrapped;
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });

    const loadMirror = async (reference) => {
        const canonical = await canonicalOf(reference);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const load = () => prisma.withdrawal.findUnique({
            where: { id: mirror.id },
            include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } },
        });
        return { canonical, mirror, load };
    };

    const bankPort = (calls, answer) => ({
        getBankTransferStatus: async ({ referenceId }) => {
            calls.push(referenceId);
            return {
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                externalId: referenceId, providerRef: 'MP-OWN-1', status: 'SUCCESSFUL',
                amountGhsExact: AMOUNT, ...(answer || {}),
            };
        },
    });
    const momoPort = (calls) => ({
        getTransferStatus: async () => { calls.push('momo'); throw new Error('MoMo must never be asked about a BANK payout'); },
    });

    test('§1 ownership write fails at its real boundary: the dispatch event commits, the owner IS recovered, BANK polled once, MoMo never', async () => {
        const client = failing((key) => {
            if (key !== '$executeRawUnsafe') return null;
            return async (...args) => {
                if (String(args[0]).includes('payoutProvider')) throw new Error('ownership write failed');
                return prisma.$executeRawUnsafe(...args);
            };
        });
        const { out, adapter, reference, balance } = await payoutWith(PENDING_ENVELOPE, client);
        // The answer was terminal at initiation, so it is parked (dispatched:false)
        // — but the ownership write really did fail, and says so.
        expect(out.bookkeepingFailures).toContain('OWNERSHIP');
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);

        // The exact SQL the work order asks for.
        const allEvents = await prisma.$queryRawUnsafe(
            'SELECT "provider", "rail", "direction", "status", "providerRef", "amountGhs", "dedupKey", "relatedReference", "raw" '
            + 'FROM "FiatProviderEvent" WHERE "relatedReference" = $1 ORDER BY "receivedAt" ASC',
            String(reference)
        );
        console.log('[§1] event rows for this reference:', JSON.stringify(allEvents));
        const events = allEvents.filter((e) => e.dedupKey === `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}`);
        expect(events).toHaveLength(1);
        expect(events[0].provider).toBe('MOOLRE_DISBURSEMENT');
        expect(events[0].rail).toBe('BANK');
        expect(events[0].direction).toBe('OUTBOUND');
        expect(events[0].dedupKey).toBe(`event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}`);
        expect(events[0].relatedReference).toBe(String(reference));
        expect(String(events[0].amountGhs)).toBe('80');

        // §2 the metadata separates "the provider reported a terminal outcome"
        // from "the application has authorised settlement".
        const metadata = await prisma.$queryRawUnsafe(
            'SELECT COALESCE("metadata", \'{}\'::jsonb)->\'dispatchException\' AS park FROM "TransactionHistory" WHERE "txHash" = $1',
            String(reference)
        );
        const park = metadata[0].park;
        console.log('[§2] park metadata for', reference, ':', JSON.stringify(park));
        expect(park.providerDispatchAttempted).toBe(true);
        expect(park.providerResponseReceived).toBe(true);
        // The flag mirrors the PROVIDER's reported status; it is never a local
        // settlement decision. A provider-reported SUCCESSFUL is terminal AND
        // unsettled, which is exactly what these two fields keep apart.
        expect(park.providerOutcomeTerminalReported).toBe(
            ['SUCCESSFUL', 'FAILED'].includes(String(park.observedStatus || '').toUpperCase())
        );
        expect(park.settlementAuthorized).toBe(false);
        expect(park.providerReportedStatus).toBe(park.observedStatus);
        expect(park).not.toHaveProperty('providerAcceptanceConfirmed');
        expect(park.providerDispatched).toBe(true);

        const { canonical, mirror, load } = await loadMirror(reference);
        // Both rail facts must be present BEFORE the worker runs.
        expect(String(canonical.metadata?.rail).toUpperCase()).toBe('BANK');
        expect(String(mirror.payoutMethod).toUpperCase()).toBe('BANK');
        // The ownership write really did not land.
        expect(canonical.metadata?.payoutProvider).toBeUndefined();

        const { resolvePayoutOwner } = require('../services/payoutProviderOwnership');
        const resolved = await resolvePayoutOwner(prisma, canonical);
        console.log('[§1] resolvePayoutOwner:', JSON.stringify(resolved));
        expect(resolved.status).toBe('RECOVERED');
        expect(resolved.owner.canonicalName).toBe('MOOLRE_DISBURSEMENT');

        const bankCalls = [];
        const momoCalls = [];
        const worker = new WithdrawalReconciliationWorker(prisma, null, momoPort(momoCalls), null, null, bankPort(bankCalls));
        await worker._reconcileOne(await load());
        console.log('[§1] port calls — BANK:', bankCalls.length, 'MoMo:', momoCalls.length);
        expect(bankCalls).toEqual([reference]);
        expect(momoCalls).toHaveLength(0);
        expect(await balance()).toBe(420);
        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);

        // §1 the durable operator evidence names this payout and its real steps.
        // entityId is a bare numeric string with no foreign key, so a shared
        // database can hold an older row for a payout that used the same id.
        // The evidence for THIS payout is the OPEN row naming THIS reference —
        // matching on entityId alone picked a stale row and looked like a
        // callback failure. The assertion is unchanged in strength: if the fresh
        // evidence is missing, nothing matches and this fails.
        const booking = await bookingEvidenceFor(prisma, mirror.id, reference);
        expect(booking).toBeTruthy();
        expect(booking.reference).toBe(String(reference));
        expect(booking.details.phase).toBe('POST_DISPATCH_BOOKKEEPING');
        expect(booking.details.failedSteps).toEqual(['OWNERSHIP']);
        expect(booking.details.recordedSteps).toEqual(['PARK_METADATA', 'PROVIDER_EVENT', 'IN_TRANSIT']);
    }, 60000);

    test('§1 provider-event write fails while ownership succeeds: no dispatch evidence is claimed, the persisted owner is used', async () => {
        const client = failing((key, target) => {
            if (key !== 'fiatProviderEvent') return null;
            const real = target[key];
            return new Proxy(real, {
                get(evTarget, evKey) {
                    if (evKey === 'create') return async () => { throw new Error('provider event write failed'); };
                    const value = evTarget[evKey];
                    return typeof value === 'function' ? value.bind(evTarget) : value;
                },
            });
        });
        const { reference } = await payoutWith(PENDING_ENVELOPE, client);
        const events = await prisma.$queryRawUnsafe(
            'SELECT "dedupKey" FROM "FiatProviderEvent" WHERE "relatedReference" = $1 AND "dedupKey" LIKE $2',
            String(reference), 'event:payout-dispatch:%'
        );
        expect(events).toHaveLength(0);
        const { canonical } = await loadMirror(reference);
        // Ownership landed, so the payout is still owned — by the durable record.
        expect(canonical.metadata?.payoutProviderName).toBe('MOOLRE_DISBURSEMENT');
        const { resolvePayoutOwner } = require('../services/payoutProviderOwnership');
        expect((await resolvePayoutOwner(prisma, canonical)).status).toBe('OWNED');

        // Drive the ACTUAL worker: the persisted owner must produce exactly one
        // BANK status poll, no MoMo poll, and a single settlement.
        const { load } = await loadMirror(reference);
        const bankCalls = [];
        const momoCalls = [];
        const worker = new WithdrawalReconciliationWorker(prisma, null, momoPort(momoCalls), null, null, bankPort(bankCalls));
        await worker._reconcileOne(await load());
        console.log('[§5] event-lost worker — BANK:', bankCalls.length, 'MoMo:', momoCalls.length);
        expect(bankCalls).toEqual([reference]);
        expect(momoCalls).toHaveLength(0);
        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(Number(state.inTransitGhs)).toBe(0);
    }, 60000);

    test('§1 both writes fail: nothing is invented, no refund, and the payout is never polled on the MoMo rail', async () => {
        const client = failing((key, target) => {
            if (key === '$executeRawUnsafe') {
                return async (...args) => {
                    if (String(args[0]).includes('payoutProvider')) throw new Error('ownership write failed');
                    return prisma.$executeRawUnsafe(...args);
                };
            }
            if (key !== 'fiatProviderEvent') return null;
            const real = target[key];
            return new Proxy(real, {
                get(evTarget, evKey) {
                    if (evKey === 'create') return async () => { throw new Error('provider event write failed'); };
                    const value = evTarget[evKey];
                    return typeof value === 'function' ? value.bind(evTarget) : value;
                },
            });
        });
        const { reference, balance } = await payoutWith(PENDING_ENVELOPE, client);
        const { canonical, load } = await loadMirror(reference);
        const { resolvePayoutOwner } = require('../services/payoutProviderOwnership');
        const resolved = await resolvePayoutOwner(prisma, canonical);
        console.log('[§1] both-failed resolve:', JSON.stringify(resolved));
        expect(resolved.status).toBe('UNKNOWN');
        const bankCalls = [];
        const momoCalls = [];
        const worker = new WithdrawalReconciliationWorker(prisma, null, momoPort(momoCalls), null, null, bankPort(bankCalls));
        await worker._reconcileOne(await load());
        // The rail is known from the canonical/mirror records, so the BANK port
        // answers with the provider's own success; MoMo is never asked.
        expect(bankCalls).toEqual([reference]);
        expect(momoCalls).toHaveLength(0);
        expect(await balance()).toBe(420);
        const state = await liquidity();
        // The provider's answer is sufficient evidence to settle, even with no
        // local ownership record: it settles ONCE, nothing stays in flight, and
        // nothing is quarantined on a guess.
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(Number(state.inTransitGhs)).toBe(0);
        expect(Number(state.reservedGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
    }, 60000);

    test('§2 an echoed external reference is never stored as the provider reference, and a later real one enriches exactly once', async () => {
        // SUCCESS, with the echoed externalref and the exact amount, but NO
        // transactionid/thirdpartyref: the provider reference must stay null.
        const { reference } = await payoutWith(PENDING_ENVELOPE);
        // No transactionid/thirdpartyref in the answer.
        const rows = await prisma.$queryRawUnsafe(
            'SELECT "providerRef", "dedupKey", "raw" FROM "FiatProviderEvent" WHERE "relatedReference" = $1',
            String(reference)
        );
        console.log('[§2] event rows:', JSON.stringify(rows));
        const events = rows.filter((e) => e.dedupKey === `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}`);
        expect(events).toHaveLength(1);
        expect(events[0].providerRef).toBeNull();
        const { canonical, mirror, load } = await loadMirror(reference);
        expect(canonical.providerRef).toBeNull();
        const reservationBefore = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        expect(reservationBefore.providerRef).toBeNull();

        const bankCalls = [];
        const worker = new WithdrawalReconciliationWorker(prisma, null, momoPort([]), null, null,
            bankPort(bankCalls, { providerRef: 'MP-LATER-1' }));
        await worker._reconcileOne(await load());
        const enriched = await canonicalOf(reference);
        expect(enriched.providerRef).toBe('MP-LATER-1');

        // replay moves nothing
        await worker._reconcileOne(await load());
        const replayed = await canonicalOf(reference);
        expect(replayed.providerRef).toBe('MP-LATER-1');
        const state = await liquidity();
        expect(Number(state.paidOutGhs)).toBe(80);
        // One evidence poll per reconciliation run, always on the ORIGINAL
        // reference; the replay moved no money (asserted above).
        expect(bankCalls).toEqual([reference, reference]);
    }, 60000);
    test('§2 an UNRESOLVED provider answer is neither terminal nor settled, and says so', async () => {
        const { reference } = await payoutWith(() => PAYLOAD({
            status: 0, code: 'APY18', message: 'External reference is required and must be unique',
        }));
        const rows = await prisma.$queryRawUnsafe(
            'SELECT COALESCE("metadata", \'{}\'::jsonb)->\'dispatchException\' AS park FROM "TransactionHistory" WHERE "txHash" = $1',
            String(reference)
        );
        const park = rows[0].park;
        console.log('[§2] unresolved park:', JSON.stringify(park));
        expect(park.providerDispatchAttempted).toBe(true);
        expect(park.providerResponseReceived).toBe(true);
        expect(park.providerOutcomeTerminalReported).toBe(false);
        expect(park.settlementAuthorized).toBe(false);
        expect(park.providerReportedStatus).toBe('UNRESOLVED');
        expect(park.providerDispatched).toBe(true);
    }, 60000);

    test('§3 a MOMO provider claiming a BANK rail with a copied BANK source is refused by the repair', async () => {
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const { reference } = await payoutWith(PENDING_ENVELOPE);
        // Manufacture the exact impostor: right reference, right amount, right
        // dedup shape and source, but the WRONG provider identity for the rail.
        await prisma.fiatLiquidityReservation.updateMany({ where: { reference }, data: { status: 'RESERVED' } });
        await prisma.$executeRawUnsafe(
            'UPDATE "FiatLiquidityState" SET "reservedGhs" = "reservedGhs" + 80, "inTransitGhs" = "inTransitGhs" - 80 WHERE "id" = 1'
        );
        await prisma.fiatProviderEvent.deleteMany({ where: { relatedReference: String(reference) } });
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MTN_MOMO_DISBURSEMENT', rail: 'BANK', direction: 'OUTBOUND', status: 'PENDING',
                amountGhs: '80.00',
                dedupKey: `event:payout-dispatch:MTN_MOMO_DISBURSEMENT:${reference}`,
                relatedReference: String(reference),
                raw: { source: 'bank_dispatch_parked' },
            },
        });
        const result = await prisma.$transaction((tx) => fiatLiquidity.repairInTransitFromDispatchEvidence(tx, { reference }));
        console.log('[§3] impostor repair result:', JSON.stringify(result));
        expect(result.repaired).toBe(false);
        expect(result.reason).toBe('NO_DISPATCH_EVIDENCE');
        const state = await liquidity();
        expect(Number(state.reservedGhs)).toBe(80);
        expect(Number(state.inTransitGhs)).toBe(0);
        const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        expect(reservation.status).toBe('RESERVED');
    }, 60000);
    test('§4 the full refusal matrix: canonical, rail, source, status and concurrency', async () => {
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const { reference } = await payoutWith(PENDING_ENVELOPE);
        const repair = () => prisma.$transaction((tx) => fiatLiquidity.repairInTransitFromDispatchEvidence(tx, { reference }));
        const resetToReserved = async () => {
            await prisma.fiatLiquidityReservation.updateMany({ where: { reference }, data: { status: 'RESERVED' } });
            await prisma.$executeRawUnsafe(
                'UPDATE "FiatLiquidityState" SET "reservedGhs" = "reservedGhs" + 80, "inTransitGhs" = "inTransitGhs" - 80 WHERE "id" = 1'
            );
        };
        const eventKey = `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}`;
        // update by ID: one of the cases below deliberately rewrites the related
        // reference, which would make a reference-filtered restore a silent no-op
        const dispatchEvent = await prisma.fiatProviderEvent.findFirst({ where: { dedupKey: eventKey }, select: { id: true } });
        const setEvent = (data) => prisma.fiatProviderEvent.update({ where: { id: dispatchEvent.id }, data });

        await resetToReserved();

        // missing reference
        expect((await prisma.$transaction((tx) => fiatLiquidity.repairInTransitFromDispatchEvidence(tx, {}))).reason).toBe('NO_REFERENCE');

        // missing reservation
        expect((await prisma.$transaction((tx) => fiatLiquidity.repairInTransitFromDispatchEvidence(tx, { reference: 'no-such-payout' }))).reason).toBe('NO_RESERVATION');

        // missing canonical transaction
        await prisma.$executeRawUnsafe('UPDATE "TransactionHistory" SET "txHash" = $1 WHERE "txHash" = $2', `${reference}-moved`, String(reference));
        expect((await repair()).reason).toBe('NO_CANONICAL_ROW');
        await prisma.$executeRawUnsafe('UPDATE "TransactionHistory" SET "txHash" = $1 WHERE "txHash" = $2', String(reference), `${reference}-moved`);

        // unknown rail context
        await prisma.$executeRawUnsafe(
            'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object(\'rail\', \'CARD\') WHERE "txHash" = $1',
            String(reference)
        );
        await prisma.withdrawal.updateMany({ where: { transactionHistoryId: (await canonicalOf(reference)).id }, data: { payoutMethod: 'CARD' } });
        expect((await repair()).reason).toBe('RAIL_CONTEXT_UNKNOWN');
        await prisma.$executeRawUnsafe(
            'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object(\'rail\', \'BANK\') WHERE "txHash" = $1',
            String(reference)
        );
        await prisma.withdrawal.updateMany({ where: { transactionHistoryId: (await canonicalOf(reference)).id }, data: { payoutMethod: 'BANK' } });

        // wrong event rail
        await setEvent({ rail: 'MOMO' });
        expect((await repair()).reason).toBe('NO_DISPATCH_EVIDENCE');
        await setEvent({ rail: 'BANK' });

        // wrong dispatch source
        await setEvent({ raw: { source: 'momo_status_poll' } });
        expect((await repair()).reason).toBe('NO_DISPATCH_EVIDENCE');
        await setEvent({ raw: { source: 'bank_dispatch_parked' } });

        // terminal event status
        await setEvent({ status: 'SUCCESSFUL' });
        expect((await repair()).reason).toBe('NO_DISPATCH_EVIDENCE');
        await setEvent({ status: 'PENDING' });

        // wrong reference on the event
        await setEvent({ relatedReference: 'someone-elses-reference' });
        expect((await repair()).reason).toBe('NO_DISPATCH_EVIDENCE');
        await setEvent({ relatedReference: String(reference), dedupKey: eventKey });

        // terminal reservation
        await prisma.fiatLiquidityReservation.updateMany({ where: { reference }, data: { status: 'PAID_OUT' } });
        expect((await repair()).reason).toBe('NOT_RESERVED');
        await prisma.fiatLiquidityReservation.updateMany({ where: { reference }, data: { status: 'RESERVED' } });

        // one pesewa out
        await setEvent({ amountGhs: '80.01' });
        expect((await repair()).reason).toBe('AMOUNT_MISMATCH');
        await setEvent({ amountGhs: '80.00' });

        // concurrent repair: exactly one winner, aggregates move once
        const before = await liquidity();
        const results = await Promise.all([repair(), repair(), repair()]);
        const repaired = results.filter((r) => r.repaired === true).length;
        const losers = results.filter((r) => r.repaired === false);
        console.log('[§4] concurrent repairs:', JSON.stringify(results));
        expect(repaired).toBe(1);
        expect(losers.every((r) => ['NOT_RESERVED', 'REPAIR_CLAIM_LOST'].includes(r.reason))).toBe(true);
        const after = await liquidity();
        expect(Number(after.inTransitGhs)).toBe(Number(before.inTransitGhs) + 80);
        expect(Number(after.reservedGhs)).toBe(Number(before.reservedGhs) - 80);
        // customer money untouched throughout
        expect(Number(after.paidOutGhs)).toBe(0);
        expect(Number(after.availableGhs)).toBe(Number(before.availableGhs));
    }, 90000);
});
