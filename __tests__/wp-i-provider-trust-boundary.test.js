// =============================================================================
// WP-I — provider trust boundary: witness authority acceptance cases.
//
// These exercise the witness authority directly against a fake transaction
// client, so they prove the DECISION LOGIC of the boundary without a database.
// Database-level cases (runtime-role insert attempts, promotion races) belong
// in the financial-durability lane and are listed in the PR as still to add —
// this suite does not claim to replace them.
// =============================================================================

'use strict';

const {
    WitnessError,
    WitnessWriterNotPermittedError,
    WitnessMismatchError,
    assertReconcilerContext,
    digestOf,
    ghsToPesewas,
    currencyForAccount,
    settledAmountFromProviderPayload,
    recordProviderSettlementWitness,
    findWitnessForOpening,
    FUNDING_TYPE_WITNESS,
} = require('../src/services/providerSettlementWitnessService');

const OPENING = {
    dedupKey: 'TREASURY_OPENING_1',
    provider: 'MOOLRE',
    amountGhs: '250.00',
    status: 'RECEIVED',
};

/** Minimal in-memory tx.client with just the two models this boundary uses. */
function fakeTx({ opening = OPENING } = {}) {
    const witnesses = [];
    return {
        witnesses,
        fiatLiquidityReceipt: {
            findUnique: async ({ where }) =>
                opening && where.dedupKey === opening.dedupKey ? { ...opening } : null,
        },
        providerSettlementWitness: {
            create: async ({ data }) => {
                // Model the schema's @unique(openingDedupKey): one witness, one opening.
                if (witnesses.some((w) => w.openingDedupKey === data.openingDedupKey)) {
                    const err = new Error('Unique constraint failed on the fields: (`openingDedupKey`)');
                    err.code = 'P2002';
                    throw err;
                }
                const row = { id: `w${witnesses.length + 1}`, ...data };
                witnesses.push(row);
                return row;
            },
            findUnique: async ({ where }) =>
                witnesses.find((w) => w.openingDedupKey === where.openingDedupKey) ?? null,
        },
    };
}

const settledPayload = { state: 'SETTLED', value: '250.00', amount: '252.50' };

function witnessInput(over = {}) {
    const raw = JSON.stringify({ ...settledPayload, externalref: 'EXT-1' });
    return {
        openingDedupKey: OPENING.dedupKey,
        provider: 'MOOLRE',
        fundingType: 'COLLECTION',
        endpoint: 'https://api.moolre.com/open/transact/status',
        requestParams: { type: 1, idtype: 1, id: 'EXT-1' },
        rawResponse: raw,
        providerPayload: settledPayload,
        amounts: { netPesewas: 25000n, grossPesewas: 25250n },
        fetchedAt: new Date('2026-11-14T09:00:00Z'),
        walletAccount: '0244000000',
        ...over,
    };
}

const RECONCILER_ENV = {
    AZM_RECONCILER_MODE: '1',
    AZM_RECONCILER_PROVIDER_KEY: 'reconciler-test-credential',
};

describe('WP-I provider trust boundary', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        Object.assign(process.env, RECONCILER_ENV);
    });
    afterEach(() => {
        for (const k of ['AZM_RECONCILER_MODE', 'AZM_RECONCILER_PROVIDER_KEY']) delete process.env[k];
        Object.assign(process.env, saved, RECONCILER_ENV);
    });
    afterAll(() => {
        delete process.env.AZM_RECONCILER_MODE;
        delete process.env.AZM_RECONCILER_PROVIDER_KEY;
        Object.assign(process.env, saved);
    });

    describe('writer authority (the credential-compromise defect)', () => {
        test('1. the API process cannot write a witness even holding the runtime credential', async () => {
            delete process.env.AZM_RECONCILER_MODE;
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput()))
                .rejects.toBeInstanceOf(WitnessWriterNotPermittedError);
            expect(tx.witnesses).toHaveLength(0);
        });

        test('1b. reconciler mode without its own provider credential is refused', async () => {
            delete process.env.AZM_RECONCILER_PROVIDER_KEY;
            await expect(async () => assertReconcilerContext())
                .rejects.toBeInstanceOf(WitnessWriterNotPermittedError);
        });

        test('24. an arbitrary reference with no pre-existing opening is refused', async () => {
            const tx = fakeTx({ opening: null });
            await expect(recordProviderSettlementWitness(tx, witnessInput()))
                .rejects.toMatchObject({ code: 'WITNESS_OPENING_NOT_FOUND' });
            expect(tx.witnesses).toHaveLength(0);
        });

        test('no witness is written when the locator is absent', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({ openingDedupKey: null })))
                .rejects.toMatchObject({ code: 'WITNESS_NO_OPENING' });
            expect(tx.witnesses).toHaveLength(0);
        });
    });

    describe('amount, currency and settled-state binding', () => {
        test('10. a witness for the wrong provider is refused at promotion', async () => {
            const tx = fakeTx();
            await recordProviderSettlementWitness(tx, witnessInput());
            await expect(findWitnessForOpening(tx, { openingDedupKey: OPENING.dedupKey, provider: 'MTN_MOMO' }))
                .rejects.toBeInstanceOf(WitnessMismatchError);
        });

        test('12. an off-by-one-pesewa settlement is refused', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({ amounts: { netPesewas: 24999n } })))
                .rejects.toBeInstanceOf(WitnessMismatchError);
            expect(tx.witnesses).toHaveLength(0);
        });

        test('14. a non-settled provider state cannot witness funding', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({
                providerPayload: { state: 'PENDING', value: '250.00' },
            }))).rejects.toMatchObject({ code: 'WITNESS_PROVIDER_STATE_NOT_SETTLED' });
            expect(tx.witnesses).toHaveLength(0);
        });

        test('13. currency is resolved from the account mapping, never inferred', () => {
            expect(currencyForAccount('0244000000', { '0244000000': 'GHS' })).toBe('GHS');
            expect(() => currencyForAccount('0244999999', { '0244000000': 'GHS' }))
                .toThrow(WitnessError);
            expect(() => currencyForAccount('', {})).toThrow(WitnessError);
        });

        test('21. gross and net differ: only net may be credited', () => {
            const amounts = settledAmountFromProviderPayload({ amount: '252.50', value: '250.00' });
            expect(amounts.netPesewas).toBe(25000n);
            expect(amounts.grossPesewas).toBe(25250n);
            expect(amounts.feePesewas).toBe(250n);
        });

        test('21b. a payload with no net value is refused rather than defaulting to gross', () => {
            expect(() => settledAmountFromProviderPayload({ amount: '252.50' }))
                .toThrow(WitnessError);
        });

        test('19. an unsupported funding type has no witness kind', () => {
            expect(FUNDING_TYPE_WITNESS.WALLET_INFLOW).toBe('ACCOUNT_STATEMENT_TYPE_2_PRIVATE');
            expect(FUNDING_TYPE_WITNESS.NOT_A_TYPE).toBeUndefined();
        });

        test('exact decimal parsing never drifts through a float', () => {
            expect(ghsToPesewas('0.1').toString()).toBe('10');
            expect(ghsToPesewas('100.30').toString()).toBe('10030');
            expect(() => ghsToPesewas('100.3000001')).toThrow(WitnessError);
        });
    });

    describe('immutability and tamper detection', () => {
        test('25. a witness whose retained bytes no longer hash to its digest is not promoted', async () => {
            const tx = fakeTx();
            await recordProviderSettlementWitness(tx, witnessInput());
            // Simulate a process that wrote a row directly without a provider call.
            tx.witnesses[0].rawResponse = JSON.stringify({ state: 'SETTLED', value: '250.00', forged: true });
            await expect(findWitnessForOpening(tx, { openingDedupKey: OPENING.dedupKey, provider: 'MOOLRE' }))
                .rejects.toBeInstanceOf(WitnessMismatchError);
        });

        test('a witness missing its fetch timestamp or endpoint is refused', async () => {
            const tx = fakeTx();
            await recordProviderSettlementWitness(tx, witnessInput());
            tx.witnesses[0].endpoint = '';
            await expect(findWitnessForOpening(tx, { openingDedupKey: OPENING.dedupKey }))
                .rejects.toBeInstanceOf(WitnessMismatchError);
        });

        test('26. one witness cannot serve two openings', async () => {
            const tx = fakeTx();
            await recordProviderSettlementWitness(tx, witnessInput());
            // The unique constraint on openingDedupKey is the single-use binding;
            // a second create for the same opening must not silently replace it.
            await expect(recordProviderSettlementWitness(tx, witnessInput()))
                .rejects.toThrow();
        });

        test('a valid witness is returned with its digest, timestamp and endpoint intact', async () => {
            const tx = fakeTx();
            const created = await recordProviderSettlementWitness(tx, witnessInput());
            const found = await findWitnessForOpening(tx, { openingDedupKey: OPENING.dedupKey, provider: 'MOOLRE' });
            expect(found.id).toBe(created.id);
            expect(found.rawResponseDigest).toBe(digestOf(witnessInput().rawResponse));
            expect(found.fetchedAt).toBeInstanceOf(Date);
            expect(found.netPesewas).toBe(25000n);
        });
    });
});
