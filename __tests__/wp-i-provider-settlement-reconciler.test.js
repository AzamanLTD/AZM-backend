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

    beforeEach(() => {
        process.env.AZM_RECONCILER_MODE = '1';
        process.env.AZM_RECONCILER_PROVIDER_KEY = 'reconciler-provider-key';
        process.env.WITNESS_DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.WITNESS_ACCOUNT_CURRENCY_MAP = JSON.stringify({ 'WALLET-AZM-1': 'GHS' });
        jest.resetModules();
        reconciler = require('../workers/providerSettlementReconciler');
        runner = require('../workers/run-provider-settlement-reconciler');
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        await prisma.providerSettlementWitness.deleteMany({});
        await prisma.fiatLiquidityReceipt.deleteMany({});
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        // These are PROCESS-level variables and jest --runInBand shares one
        // process across suites: leaving the reconciler mode armed would change
        // how later suites interpret a treasury opening.
        delete process.env.AZM_RECONCILER_MODE;
        delete process.env.AZM_RECONCILER_PROVIDER_KEY;
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
                evidence: { walletAccount, fundingReference: providerRef },
            },
        });
    }

    function stubProvider(payload, { state = 'SETTLED', httpStatus = 200 } = {}) {
        const body = JSON.stringify({
            status: 1,
            code: 'P01',
            data: { externalref: PROVIDER_REF, amount: '100.00', value: '99.00', txtype: 1, state, ...payload },
        });
        global.fetch = jest.fn().mockResolvedValue({
            status: httpStatus,
            text: async () => body,
        });
        return body;
    }

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
        expect(results[0].reason).toMatch(/unknown opening/i);
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
        expect(results[0].reason).toMatch(/no provider reference/i);
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
        expect(results[0].reason).toMatch(/provider status 500/i);
        expect(await prisma.providerSettlementWitness.count()).toBe(0);
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
