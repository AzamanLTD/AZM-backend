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
    // §WP-I: the opening carries the trusted wallet the money lands in, and the
    // wallet-scoped claim identity is built from it. Without one the witness is
    // refused, so the fixture must model a real opening.
    walletAccount: '0244000001',
    // The real receipt always carries this; a witness is bound to it.
    createdAt: new Date('2026-11-14T08:00:00Z'),
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
        // The cross-path guard asks the deposit ledger whether this collection was
        // already spent. A stub transaction must expose the delegate, otherwise
        // the guard has to refuse - which is what it now does, deliberately.
        fiatProviderEvent: {
            findFirst: async () => (global.__depositUseStub ? { dedupKey: global.__depositUseStub, status: 'FUNDED' } : null),
        },
        // The shared observation claim needs raw SQL (INSERT ... ON CONFLICT) so a
        // losing racer never poisons its transaction. A stub transaction cannot
        // enforce that, so it reports the claim as acquired; the real arbitration
        // is proven against PostgreSQL in
        // __tests__/wp-i-observation-claim-concurrency.pg.test.js. Without this the
        // service fails closed, which is the correct behaviour for a client that
        // genuinely cannot enforce it.
        $executeRaw: async () => 1,
        $executeRawUnsafe: async () => 1,
        // The unresolved-case guard must be able to READ. A stub that cannot run
        // the query is refused (fail closed), so the stub models a database that
        // HAS the case table and holds no case for these fixtures.
        $queryRawUnsafe: async (sql) => (
            String(sql).includes('to_regclass')
                ? [{ t: '"ReconciliationException"' }]
                : []
        ),
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

// The documented Moolre Payment Status response: wrapper `status` plus a `data`
// object with a NUMERIC txstatus, externalref, accountnumber, net `value` and
// gross `amount`. The legacy `state`/`txstatus_label` vocabulary is no longer
// accepted for funding, so the fixtures speak the real contract.
const settledData = {
    txstatus: 1,
    externalref: 'EXT-1',
    accountnumber: '0244000000',
    value: '250.00',
    amount: '252.50',
};
const settledPayload = settledData;

function documentedEnvelope(over = {}) {
    return { status: '1', data: { ...settledData, ...over } };
}

function witnessInput(over = {}) {
    const raw = JSON.stringify(documentedEnvelope());
    return {
        openingDedupKey: OPENING.dedupKey,
        provider: 'MOOLRE',
        fundingType: 'COLLECTION',
        endpoint: 'https://api.moolre.com/open/transact/status',
        requestParams: { type: 1, idtype: 1, id: 'EXT-1' },
        rawResponse: raw,
        providerPayload: settledData,
        amounts: { netPesewas: 25000n, grossPesewas: 25250n },
        fetchedAt: new Date('2026-11-14T09:00:00Z'),
        walletAccount: '0244000000',
        // Currency comes from this mapping, never from the payload.
        currencyMapping: { '0244000000': 'GHS' },
        ...over,
    };
}

const RECONCILER_ENV = {
    AZM_RECONCILER_MODE: '1',
    AZM_RECONCILER_PROVIDER_USER: 'reconciler-user',
            AZM_RECONCILER_PROVIDER_PUBKEY: 'reconciler-test-credential',
};

describe('WP-I provider trust boundary', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        Object.assign(process.env, RECONCILER_ENV);
    });
    afterEach(() => {
        for (const k of ['AZM_RECONCILER_MODE', 'AZM_RECONCILER_PROVIDER_USER', 'AZM_RECONCILER_PROVIDER_PUBKEY']) delete process.env[k];
        Object.assign(process.env, saved, RECONCILER_ENV);
    });
    afterAll(() => {
        delete process.env.AZM_RECONCILER_MODE;
        delete process.env.AZM_RECONCILER_PROVIDER_USER;
        delete process.env.AZM_RECONCILER_PROVIDER_PUBKEY;
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
            delete process.env.AZM_RECONCILER_PROVIDER_USER;
        delete process.env.AZM_RECONCILER_PROVIDER_PUBKEY;
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

        test('13c. a payload with no externalref never reaches a claim, so it cannot be keyed on a substitute identifier', async () => {
            // The claim reference must be the provider's externalref. If it were
            // ever allowed to fall back to data.transactionid, this payment would
            // be claimed under a SECOND identity while the deposit path holds the
            // canonical one — one payment, two economic uses. The parser refuses
            // the payload; this test also proves no claim is attempted, which is
            // what keeps that true if the parser is loosened.
            const tx = fakeTx();
            let claimAttempts = 0;
            tx.$executeRawUnsafe = async () => { claimAttempts += 1; return 1; };
            const payload = { txstatus: 1, accountnumber: '0244000000', value: '250.00', amount: '252.50' };
            await expect(recordProviderSettlementWitness(tx, witnessInput({
                rawResponse: JSON.stringify({ status: '1', data: payload }),
                providerPayload: payload,
            }))).rejects.toMatchObject({ code: 'WITNESS_IDENTITY_FIELDS_REQUIRED' });
            expect(claimAttempts).toBe(0);
            expect(tx.witnesses).toHaveLength(0);
        });

        test('14. a non-settled provider state cannot witness funding', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({
                rawResponse: JSON.stringify(documentedEnvelope({ txstatus: 0 })),
                providerPayload: { ...settledData, txstatus: 0 },
            }))).rejects.toMatchObject({ code: 'WITNESS_PROVIDER_STATE_NOT_SETTLED' });
            expect(tx.witnesses).toHaveLength(0);
        });

        test('13a. an unmapped wallet account refuses to witness at all', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({ currencyMapping: {} })))
                .rejects.toMatchObject({ code: 'WITNESS_ACCOUNT_UNMAPPED' });
            expect(tx.witnesses).toHaveLength(0);
        });

        test('13b. the recorded currency is the mapped one, not a constant', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({
                currencyMapping: { '0244000000': 'USD' },
            }))).rejects.toMatchObject({ code: 'WITNESS_CURRENCY_UNSUPPORTED' });

            const ok = fakeTx();
            const w = await recordProviderSettlementWitness(ok, witnessInput());
            expect(w.currency).toBe('GHS');
        });

        test('13c. an untrusted funding provider cannot witness treasury money', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({ provider: 'AZM_TREASURY' })))
                .rejects.toMatchObject({ code: 'WITNESS_PROVIDER_UNTRUSTED' });
        });

        test('13d. a witness cannot be dated in the future', async () => {
            const tx = fakeTx();
            const future = new Date(Date.now() + 10 * 60_000);
            await expect(recordProviderSettlementWitness(tx, witnessInput({ fetchedAt: future })))
                .rejects.toMatchObject({ code: 'WITNESS_FETCH_TIME_IN_FUTURE' });
        });

        test('13e. a fetch that predates the opening cannot evidence it', async () => {
            const tx = fakeTx();
            await expect(recordProviderSettlementWitness(tx, witnessInput({
                fetchedAt: new Date('2020-01-01T00:00:00Z'),
            }))).rejects.toBeInstanceOf(WitnessMismatchError);
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

    test('CROSS-PATH: a collection that already settled a deposit cannot be witnessed', async () => {
        const tx = fakeTx();
        global.__depositUseStub = 'event:moolre-collection:EXT-1';
        try {
            await expect(recordProviderSettlementWitness(tx, witnessInput()))
                .rejects.toMatchObject({ code: 'WITNESS_OBSERVATION_SPENT_ON_DEPOSIT' });
            expect(tx.witnesses).toHaveLength(0);
        } finally {
            global.__depositUseStub = null;
        }
    });

    describe('immutability and tamper detection', () => {
        test('25. a witness whose retained bytes no longer hash to its digest is not promoted', async () => {
            const tx = fakeTx();
            await recordProviderSettlementWitness(tx, witnessInput());
            // Simulate a process that wrote a row directly without a provider call.
            tx.witnesses[0].rawResponse = JSON.stringify(documentedEnvelope({ txstatus: 1, transactionid: 'forged' }));
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
