// __tests__/wp-i-reconciler-exit-semantics.test.js
// =============================================================================
// §6 — THE RECONCILER MUST NOT EXIT 0 ON AN UNWITNESSED OPENING
//
// The CLI used to end with `return results.every((r) => r.witnessed) ? 0 : 0;`
// — both branches 0. A scheduler reading the exit code therefore saw a
// successful reconciliation whenever the process finished, including the case
// where the provider refused every opening and no witness was written.
//
// The contract proved here:
//   0  all requested openings witnessed (or already authoritatively witnessed)
//   1  usage / credential refusal, nothing attempted
//   2  fatal error
//   3  at least one requested opening did NOT receive a witness
//
// The reconciler is mocked: this suite is about the process contract, not about
// provider parsing, which the PostgreSQL reconciler suite proves separately.
// =============================================================================
'use strict';

jest.mock('../workers/providerSettlementReconciler', () => ({
    reconcileTreasuryOpenings: jest.fn(),
}));

const { reconcileTreasuryOpenings } = require('../workers/providerSettlementReconciler');
const { main, EXIT } = require('../workers/run-provider-settlement-reconciler');

const COMPLETE_ENV = {
    AZM_RECONCILER_MODE: '1',
    AZM_RECONCILER_PROVIDER_USER: 'test-user',
    AZM_RECONCILER_PROVIDER_PUBKEY: 'test-pubkey',
    WITNESS_DATABASE_URL: 'postgresql://reconciler@127.0.0.1:5432/placeholder',
    WITNESS_ACCOUNT_CURRENCY_MAP: '{"WALLET-A":"GHS"}',
};

const saved = {};
let stdout;
let stderr;

beforeEach(() => {
    for (const [k, v] of Object.entries(COMPLETE_ENV)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    stdout = [];
    stderr = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
    reconcileTreasuryOpenings.mockReset();
});

afterEach(() => {
    for (const k of Object.keys(COMPLETE_ENV)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
});

const argv = (...keys) => ['node', 'run-provider-settlement-reconciler.js', ...keys];

describe('§6 reconciler exit semantics', () => {
    test('all witnessed exits 0', async () => {
        reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: true, witnessId: 'w1', netPesewas: 500n },
            { openingDedupKey: 'B', witnessed: true, witnessId: 'w2', netPesewas: 700n },
        ]);
        await expect(main(argv('A', 'B'))).resolves.toBe(EXIT.OK);
        // BigInt must reach the operator as an exact decimal string.
        const out = JSON.parse(stdout.join(''));
        expect(out.results[0].netPesewas).toBe('500');
    });

    test('all refused exits 3, not 0', async () => {
        reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: false, reason: 'PROVIDER_NOT_SETTLED_PENDING' },
            { openingDedupKey: 'B', witnessed: false, reason: 'OPENING_NOT_FOUND' },
        ]);
        await expect(main(argv('A', 'B'))).resolves.toBe(EXIT.NOT_WITNESSED);
        expect(stderr.join('')).toMatch(/2 of 2 opening\(s\) were NOT witnessed/);
        expect(JSON.parse(stdout.join('')).results).toHaveLength(2);
    });

    test('a mixed run is a refusal, not a success', async () => {
        reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: true, witnessId: 'w1' },
            { openingDedupKey: 'B', witnessed: false, reason: 'RECONCILER_WALLET_MISMATCH' },
        ]);
        await expect(main(argv('A', 'B'))).resolves.toBe(EXIT.NOT_WITNESSED);
        expect(stderr.join('')).toMatch(/1 of 2 opening\(s\) were NOT witnessed/);
    });

    test('a missing witnessed flag counts as not witnessed', async () => {
        // Defensive: an unexpected result shape must not read as success.
        reconcileTreasuryOpenings.mockResolvedValue([{ openingDedupKey: 'A' }]);
        await expect(main(argv('A'))).resolves.toBe(EXIT.NOT_WITNESSED);
    });

    test('a fatal error exits 2, distinct from a refusal', async () => {
        reconcileTreasuryOpenings.mockRejectedValue(new Error('database went away'));
        await expect(main(argv('A'))).resolves.toBe(EXIT.FATAL);
        expect(stderr.join('')).toMatch(/fatal: database went away/);
    });

    test('usage and credential refusals exit 1 and attempt nothing', async () => {
        // main() returns a bare number on the usage path and a promise once it
        // gets as far as reconciling, so both shapes are normalised here.
        await expect(Promise.resolve(main(argv()))).resolves.toBe(EXIT.USAGE);
        expect(reconcileTreasuryOpenings).not.toHaveBeenCalled();

        delete process.env.WITNESS_DATABASE_URL;
        await expect(Promise.resolve(main(argv('A')))).resolves.toBe(EXIT.USAGE);
        expect(stderr.join('')).toMatch(/missing WITNESS_DATABASE_URL/);
        expect(reconcileTreasuryOpenings).not.toHaveBeenCalled();
    });

    test('the four outcomes are distinct codes', () => {
        const codes = new Set([EXIT.OK, EXIT.USAGE, EXIT.FATAL, EXIT.NOT_WITNESSED]);
        expect(codes.size).toBe(4);
        expect(EXIT.OK).toBe(0);
    });
});
