'use strict';

/**
 * WP-I — the separate provider settlement reconciler.
 *
 * This component is the ONLY writer of a settlement witness, and it is
 * deliberately not part of the API process. These cases pin the properties
 * that make that separation real rather than decorative:
 *   - it refuses to run without its own credentials (partial authority = no run)
 *   - it never queries a reference it was handed but cannot ground in an
 *     existing treasury opening
 *   - economic fields come from the provider response, never from the request
 *   - one provider observation cannot fund two openings
 *
 * Real PostgreSQL for the writes; only the provider HTTP call is stubbed.
 */

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[wp-i-provider-settlement-reconciler.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('WP-I provider settlement reconciler (real PostgreSQL, stubbed provider)', () => {
    let prisma;
    let reconciler;
    let runner;
    const originalFetch = global.fetch;

    const OPENING_A = 'TREASURY-OPENING-A';
    const OPENING_B = 'TREASURY-OPENING-B';
    const PROVIDER_REF = 'MREF-1001';

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    // This suite must start from a known state. afterEach alone meant the FIRST
    // case inherited whatever an earlier suite left in the witness table, so a
    // "no witness was written" assertion could read another suite's row.
    const clearFixtureTables = async () => {
        await prisma.fiatProviderEvent.deleteMany({});
        await prisma.providerSettlementWitness.deleteMany({});
        await prisma.fiatLiquidityReceipt.deleteMany({});
    };

    beforeEach(async () => {
        await clearFixtureTables();
        process.env.AZM_RECONCILER_MODE = '1';
        process.env.AZM_RECONCILER_PROVIDER_USER = 'reconciler-user';
        process.env.AZM_RECONCILER_PROVIDER_PUBKEY = 'reconciler-public-key';
        // Deliberately NOT pinned: one reconciler may serve several wallets, and the
        // pin is an operator assertion exercised by its own case.
        delete process.env.AZM_RECONCILER_ACCOUNT_NUMBER;
        process.env.WITNESS_DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.WITNESS_ACCOUNT_CURRENCY_MAP = JSON.stringify({ 'WALLET-AZM-1': 'GHS' });
        jest.resetModules();
        reconciler = require('../workers/providerSettlementReconciler');
        runner = require('../workers/run-provider-settlement-reconciler');
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        await clearFixtureTables();
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        // These are PROCESS-level variables and jest --runInBand shares one
        // process across suites: leaving the reconciler mode armed would change
        // how later suites interpret a treasury opening.
        delete process.env.AZM_RECONCILER_MODE;
        delete process.env.AZM_RECONCILER_PROVIDER_USER;
        delete process.env.AZM_RECONCILER_PROVIDER_PUBKEY;
        delete process.env.AZM_RECONCILER_ACCOUNT_NUMBER;
        delete process.env.WITNESS_DATABASE_URL;
        delete process.env.WITNESS_ACCOUNT_CURRENCY_MAP;
        if (prisma) await prisma.$disconnect();
    });

    // The opening records what we ACTUALLY HOLD: the provider's net (`value`),
    // not the payer's gross (`amount`). The stub reports gross 100.00 / net 99.00.
    async function seedOpening(dedupKey, { providerRef = PROVIDER_REF, walletAccount = 'WALLET-AZM-1', amountGhs = 99 } = {}) {
        return prisma.fiatLiquidityReceipt.create({
            data: {
                provider: 'MOOLRE',
                dedupKey,
                amountGhs,
                status: 'RECEIVED',
                providerRef,
                // WP-I: the account is a COLUMN now, not a claim inside evidence JSON.
                walletAccount,
                evidence: { fundingReference: providerRef },
            },
        });
    }

    function stubProvider(payload, { state = 'SETTLED', httpStatus = 200 } = {}) {
        const body = JSON.stringify({
            status: 1,
            code: 'P01',
            data: {
                externalref: PROVIDER_REF, accountnumber: 'WALLET-AZM-1', transactionid: 'TXN-AZM-1',
                amount: '100.00', value: '99.00', txtype: 1,
                txstatus: ({ SETTLED: 1, PENDING: 0, FAILED: 2 })[state] ?? 1,
                state, ...payload,
            },
        });
        global.fetch = jest.fn().mockResolvedValue({
            status: httpStatus,
            text: async () => body,
        });
        return body;
    }

    // Paired with the wallet binding: an answer to a DIFFERENT question is not
    // evidence about this opening, even when wallet and amount agree.
    test('a provider answer naming a DIFFERENT reference cannot vouch for this opening', async () => {
        await seedOpening(OPENING_A, { walletAccount: 'WALLET-AZM-1' });
        stubProvider({ externalref: 'MREF-SOMEBODY-ELSE' });

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toBe('WITNESS_REFERENCE_MISMATCH');
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    // Transport timeout: the provider never answered. An unanswered question is
    // not a failure and is certainly not success — it must produce no witness.
    test('a provider call that times out never becomes a witness', async () => {
        await seedOpening(OPENING_A, { walletAccount: 'WALLET-AZM-1' });
        const timeout = new Error('The operation was aborted due to timeout');
        timeout.name = 'TimeoutError';
        global.fetch = jest.fn().mockRejectedValue(timeout);

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toBe('PROVIDER_TRANSPORT_ERROR_TIMEOUT');
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
        // The opening is untouched: a timeout is not a failed payment.
        const row = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: OPENING_A } });
        expect(row.status).toBe('RECEIVED');
    });

    test('a provider answer for a DIFFERENT wallet cannot vouch for this opening', async () => {
        await seedOpening(OPENING_A, { walletAccount: 'WALLET-AZM-1' });
        // Settled, correct amount, correct reference — but another wallet's money.
        stubProvider({ accountnumber: 'WALLET-SOMEBODY-ELSE' });

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toBe('WITNESS_ACCOUNT_MISMATCH');
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    test('a malformed currency map refuses every opening instead of guessing GHS', async () => {
        await seedOpening(OPENING_A, { walletAccount: 'WALLET-AZM-1' });
        stubProvider({});
        process.env.WITNESS_ACCOUNT_CURRENCY_MAP = '{not json';

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toBe('WITNESS_ACCOUNT_MAPPING_INVALID');
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    test('a reference that exists only inside evidence JSON cannot drive a lookup', async () => {
        await prisma.fiatLiquidityReceipt.create({
            data: {
                provider: 'MOOLRE', dedupKey: OPENING_A, amountGhs: 99, status: 'RECEIVED',
                providerRef: null, walletAccount: 'WALLET-AZM-1',
                // The runtime can write this. It is not evidence of a payment.
                evidence: { fundingReference: 'INVENTED-BY-RUNTIME' },
            },
        });
        stubProvider({});

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toBe('OPENING_HAS_NO_PROVIDER_REFERENCE');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    // ── The wallet comes from the opening, never from a claim or the environment ──
    test('the wallet account is read from the opening row, not from evidence JSON', async () => {
        await seedOpening(OPENING_A, { walletAccount: 'WALLET-FROM-COLUMN' });
        stubProvider({ accountnumber: 'WALLET-FROM-COLUMN' });
        delete process.env.AZM_RECONCILER_ACCOUNT_NUMBER;
        process.env.WITNESS_ACCOUNT_CURRENCY_MAP = JSON.stringify({ 'WALLET-FROM-COLUMN': 'GHS' });

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(true);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.accountnumber).toBe('WALLET-FROM-COLUMN');
    });

    test('an opening with no stored wallet account is refused, never guessed', async () => {
        await prisma.fiatLiquidityReceipt.create({
            data: {
                provider: 'MOOLRE', dedupKey: OPENING_A, amountGhs: 99, status: 'RECEIVED',
                providerRef: PROVIDER_REF,
                // A claim inside evidence is exactly what must NOT be trusted.
                evidence: { walletAccount: 'WALLET-AZM-1' },
            },
        });
        stubProvider({});

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toBe('OPENING_HAS_NO_WALLET_ACCOUNT');
        expect(global.fetch).not.toHaveBeenCalled();
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    test('a reconciler pinned to a different wallet refuses instead of querying it', async () => {
        await seedOpening(OPENING_A, { walletAccount: 'WALLET-AZM-1' });
        stubProvider({});
        process.env.AZM_RECONCILER_ACCOUNT_NUMBER = 'WALLET-SOMEONE-ELSE';

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].reason).toBe('RECONCILER_WALLET_MISMATCH');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('the documented backfill fills a null wallet account from witnessed evidence', async () => {
        await prisma.fiatLiquidityReceipt.create({
            data: { provider: 'MOOLRE', dedupKey: OPENING_A, amountGhs: 99, status: 'RECEIVED', providerRef: PROVIDER_REF },
        });
        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: OPENING_A, observationKey: 'backfill-obs', provider: 'MOOLRE',
                fundingType: 'COLLECTION', witnessKind: 'TYPE1_STATUS', walletAccount: 'WALLET-BACKFILLED',
                currency: 'GHS', netPesewas: 9900n, providerState: 'SETTLED',
                endpoint: 'https://api.moolre.com/open/transact/status', requestParams: {},
                rawResponseDigest: 'digest', rawResponse: '{}', fetchedAt: new Date(),
            },
        });

        await prisma.$executeRawUnsafe(
            `UPDATE "FiatLiquidityReceipt" r SET "walletAccount" = w."walletAccount"
               FROM "ProviderSettlementWitness" w
              WHERE w."openingDedupKey" = r."dedupKey" AND r."walletAccount" IS NULL`
        );

        const row = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: OPENING_A } });
        expect(row.walletAccount).toBe('WALLET-BACKFILLED');
    });

    // ── Authority: refuses to run on partial credentials ─────────────────────
    test('the operator entrypoint refuses to run when any of its own credentials is missing', async () => {
        for (const name of runner.REQUIRED_ENV) {
            const saved = process.env[name];
            delete process.env[name];
            const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const code = await runner.main(['node', 'runner', OPENING_A]);
            stderr.mockRestore();
            expect(code).toBe(1);
            process.env[name] = saved;
        }
    });

    // ── Case 24: no pre-existing opening means no lookup ─────────────────────
    test('an opening key that does not exist is refused and nothing is fetched', async () => {
        const fetchSpy = jest.fn();
        global.fetch = fetchSpy;

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: ['NOT-AN-OPENING'] });

        expect(results).toHaveLength(1);
        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toMatch(/OPENING_NOT_FOUND|unknown opening/i);
        // The reconciler must not go and ask the provider about a reference it
        // was simply told about.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    test('an opening with no provider reference is refused without a lookup', async () => {
        await prisma.fiatLiquidityReceipt.create({
            data: { provider: 'MOOLRE', dedupKey: OPENING_A, amountGhs: 100, status: 'RECEIVED', providerRef: null, evidence: {} },
        });
        const fetchSpy = jest.fn();
        global.fetch = fetchSpy;

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toMatch(/OPENING_HAS_NO_PROVIDER_REFERENCE|no provider reference/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    // ── Positive control: genuine provider evidence becomes a witness ─────────
    test('a settled provider observation is fetched independently and written as a witness', async () => {
        await seedOpening(OPENING_A);
        stubProvider({});

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(true);
        const witnesses = await prisma.providerSettlementWitness.findMany({});
        expect(witnesses).toHaveLength(1);
        const witness = witnesses[0];
        expect(witness.provider).toBe('MOOLRE');
        // Economic fields come from the provider bytes, not from our request:
        // net 99.00 (the `value` field) rather than the gross 100.00.
        expect(String(witness.netPesewas)).toBe('9900');
        expect(witness.walletAccount).toBe('WALLET-AZM-1');
        expect(witness.endpoint).toContain('transact/status');
    });

    test('a non-final provider state never becomes a witness', async () => {
        await seedOpening(OPENING_A);
        stubProvider({}, { state: 'PENDING' });

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    test('a provider HTTP failure never becomes a witness', async () => {
        await seedOpening(OPENING_A);
        stubProvider({}, { httpStatus: 500 });

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toMatch(/PROVIDER_TRANSPORT_HTTP_500|provider status 500/i);
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    // ── Case 11: an OUTBOUND observation cannot fund the treasury ───────────
    test('11: an OUTBOUND provider observation cannot fund a treasury opening, while the INBOUND one can', async () => {
        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        const witnesses = require('../src/services/providerSettlementWitnessService');

        await prisma.fiatLiquidityState.deleteMany({ where: { id: 1 } });
        await prisma.fiatLiquidityState.create({
            data: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
        });

        // A treasury opening funded by a real, independently fetched witness.
        await prisma.$transaction((tx) => fiatLiquidity.recordReceipt(tx, {
            provider: 'AZM_TREASURY', rail: 'INTERNAL', dedupKey: 'treasury:dir-a',
            amountGhs: 100, treasury: true, evidence: { kind: 'AUDITED_TREASURY_OPENING' },
        }));
        const raw = JSON.stringify({ status: 1, data: { state: 'SETTLED', value: '100.00', accountnumber: 'WALLET-AZM-1' } });
        await prisma.$transaction((tx) => witnesses.recordProviderSettlementWitness(tx, {
            openingDedupKey: 'treasury:dir-a',
            provider: 'MOOLRE',
            fundingType: 'COLLECTION',
            endpoint: 'https://api.moolre.com/open/transact/status',
            requestParams: { reference: 'REF-DIR' },
            rawResponse: raw,
            providerPayload: { state: 'SETTLED', value: '100.00' },
            fetchedAt: new Date(),
            walletAccount: 'WALLET-AZM-1',
            currencyMapping: { 'WALLET-AZM-1': 'GHS' },
        }));

        // The matching settlement at the provider is OUTBOUND — money leaving,
        // not money arriving. It must not open the treasury.
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', rail: 'BANK', direction: 'OUTBOUND', status: 'SETTLED',
                providerRef: 'REF-DIR', dedupKey: 'event:dir-out', amountGhs: 100,
            },
        });

        await expect(prisma.$transaction((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
            dedupKey: 'treasury:dir-a', providerEventDedupKey: 'event:dir-out',
        }))).rejects.toThrow(/OUTBOUND/i);

        const stateAfterOutbound = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(String(stateAfterOutbound.availableGhs)).toBe('0');

        // Positive control: the SAME opening with the correct INBOUND
        // observation does fund, so the refusal above was about direction.
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', rail: 'BANK', direction: 'INBOUND', status: 'SETTLED',
                providerRef: 'REF-DIR-IN', dedupKey: 'event:dir-in', amountGhs: 100,
            },
        });
        await prisma.$transaction((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
            dedupKey: 'treasury:dir-a', providerEventDedupKey: 'event:dir-in',
        }));
        const stateAfterInbound = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(String(stateAfterInbound.availableGhs)).toBe('100');
    });

    // ── Case 19: funding type the status endpoint cannot witness ────────────
    test('19: a funding type with no supported witness is refused', async () => {
        await seedOpening(OPENING_A);
        stubProvider({});
        const witnesses = require('../src/services/providerSettlementWitnessService');

        await expect(prisma.$transaction((tx) => witnesses.recordProviderSettlementWitness(tx, {
            openingDedupKey: OPENING_A,
            provider: 'MOOLRE',
            // A bank deposit cannot be evidenced by the collection status
            // endpoint; the type must be refused rather than coerced.
            fundingType: 'BANK_DEPOSIT_QUERIED_AS_TYPE_1',
            endpoint: 'https://api.moolre.com/open/transact/status',
            requestParams: { id: PROVIDER_REF },
            rawResponse: JSON.stringify({ status: 1, data: { state: 'SETTLED', value: '99.00' } }),
            providerPayload: { state: 'SETTLED', value: '99.00' },
            fetchedAt: new Date(),
            walletAccount: 'WALLET-AZM-1',
            currencyMapping: { 'WALLET-AZM-1': 'GHS' },
        }))).rejects.toMatchObject({ code: 'WITNESS_FUNDING_TYPE_UNSUPPORTED' });

        expect(await prisma.providerSettlementWitness.count()).toBe(0);
        const opening = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: OPENING_A } });
        expect(opening.status).toBe('RECEIVED');
    });

    // ── Case 20: currency cannot be proven from the account mapping ─────────
    test('20: an account absent from the currency mapping is refused, never defaulted to GHS', async () => {
        await prisma.fiatLiquidityReceipt.create({
            data: {
                provider: 'MOOLRE', dedupKey: OPENING_A, amountGhs: 99, status: 'RECEIVED',
                providerRef: PROVIDER_REF,
                walletAccount: 'WALLET-UNMAPPED',
                evidence: { fundingReference: PROVIDER_REF },
            },
        });
        stubProvider({});
        const witnesses = require('../src/services/providerSettlementWitnessService');

        const results = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });

        expect(results[0].witnessed).toBe(false);
        expect(results[0].reason).toMatch(/WITNESS_ACCOUNT_UNMAPPED|currency/i);
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
    });

    // ── Case 25: a witness written without a provider call is detected ──────
    test('25: a witness whose retained bytes no longer match its digest is refused at promotion', async () => {
        await seedOpening(OPENING_A);
        stubProvider({});
        const witnesses = require('../src/services/providerSettlementWitnessService');

        const [result] = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });
        expect(result.witnessed).toBe(true);

        // Simulate a compromised writer: the row exists and looks legitimate,
        // but its stored bytes were swapped after the fact. The digest is the
        // detection: the witness stops being usable evidence.
        await prisma.providerSettlementWitness.update({
            where: { openingDedupKey: OPENING_A },
            data: { rawResponse: JSON.stringify({ status: 1, data: { state: 'SETTLED', value: '999999.00' } }) },
        });

        await expect(prisma.$transaction((tx) => witnesses.findWitnessForOpening(tx, {
            openingDedupKey: OPENING_A, provider: 'MOOLRE', openingPesewas: 9900n,
        }))).rejects.toMatchObject({ code: 'WITNESS_MISMATCH' });
    });

    // ── Case 26: one observation cannot fund two openings ────────────────────
    test('one provider observation cannot be used to witness a second opening', async () => {
        await seedOpening(OPENING_A);
        await seedOpening(OPENING_B); // same providerRef, different opening
        stubProvider({});

        const first = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_A] });
        expect(first[0].witnessed).toBe(true);

        const second = await reconciler.reconcileTreasuryOpenings({ openingDedupKeys: [OPENING_B] });

        expect(second[0].witnessed).toBe(false);
        expect(await prisma.providerSettlementWitness.count()).toBe(1);
    });
});
