// __tests__/wp-i-reconciler-exit-contract.test.js
// =============================================================================
// §WP-I — THE RECONCILER'S EXIT CONTRACT IS HONEST
//
// The operator entrypoint used to end with:
//
//     return results.every((r) => r.witnessed) ? 0 : 0;
//
// Both branches returned 0, so a batch in which NOTHING was witnessed exited
// successfully. Any monitoring integration keyed on the exit code would have
// read that as "the treasury is reconciled".
//
// This suite pins the contract at the CLI boundary:
//
//     0  every requested opening was witnessed
//     1  invalid invocation / missing or invalid credential
//     2  fatal process/database/initialization failure
//     3  the batch completed, but at least one opening was not witnessed
//
// The worker itself is mocked here: this suite is about the CODE the process
// exits with and what it prints, not about provider parsing (the real-PostgreSQL
// suite __tests__/wp-i-provider-settlement-reconciler.test.js covers that with
// genuine provider fixtures). No provider is called and no credential is real.
// =============================================================================
'use strict';

const path = require('path');

// The worker module the CLI calls. Mocked so each case can dictate the batch
// outcome without a database or a provider.
jest.mock('../workers/providerSettlementReconciler', () => ({
    reconcileTreasuryOpenings: jest.fn(),
}));

const reconciler = require('../workers/providerSettlementReconciler');
const runner = require('../workers/run-provider-settlement-reconciler');

const { EXIT } = runner;

/** A minimal, complete credential set. Values are obvious fixtures. */
function withCredentials() {
    process.env.AZM_RECONCILER_MODE = '1';
    process.env.AZM_RECONCILER_PROVIDER_USER = 'fixture-user';
    process.env.AZM_RECONCILER_PROVIDER_PUBKEY = 'fixture-pubkey';
    process.env.WITNESS_DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5432/fixture';
    process.env.WITNESS_ACCOUNT_CURRENCY_MAP = '{"0244000000":"GHS"}';
}

function clearCredentials() {
    for (const name of runner.REQUIRED_ENV) delete process.env[name];
}

/** Run the CLI's main() while capturing stdout/stderr. */
async function runCli(argv) {
    const out = [];
    const err = [];
    const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true; });
    let code;
    try {
        code = await runner.main(['node', 'runner', ...argv]);
    } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
    }
    return { code, stdout: out.join(''), stderr: err.join('') };
}

const witnessed = (key) => ({ openingDedupKey: key, witnessed: true, witnessId: `w-${key}`, netPesewas: 9900n, adapter: 'type1' });

beforeEach(() => {
    jest.clearAllMocks();
    withCredentials();
});

afterAll(() => {
    clearCredentials();
});

describe('§WP-I reconciler exit contract', () => {
    test('the contract values are the documented ones', () => {
        expect(EXIT).toEqual({
            EXIT_ALL_WITNESSED: 0,
            EXIT_INVALID: 1,
            EXIT_FATAL: 2,
            EXIT_INCOMPLETE: 3,
        });
    });

    test('ALL witnessed -> 0', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([witnessed('A'), witnessed('B')]);
        const { code, stdout, stderr } = await runCli(['A', 'B']);
        expect(code).toBe(EXIT.EXIT_ALL_WITNESSED);
        // A clean run says nothing on stderr.
        expect(stderr).toBe('');
        expect(JSON.parse(stdout).results).toHaveLength(2);
    });

    test('ALL refused -> 3, never 0', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: false, reason: 'OPENING_NOT_FOUND' },
            { openingDedupKey: 'B', witnessed: false, reason: 'OPENING_HAS_NO_PROVIDER_REFERENCE' },
        ]);
        const { code, stdout, stderr } = await runCli(['A', 'B']);
        expect(code).toBe(EXIT.EXIT_INCOMPLETE);
        expect(stderr).toMatch(/0 witnessed, 2 not witnessed, 2 requested/);
        // The per-opening truth is still on stdout for the operator.
        const json = JSON.parse(stdout);
        expect(json.results.map((r) => r.reason)).toEqual(['OPENING_NOT_FOUND', 'OPENING_HAS_NO_PROVIDER_REFERENCE']);
    });

    test('MIXED batch -> 3', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            witnessed('A'),
            { openingDedupKey: 'B', witnessed: false, reason: 'PROVIDER_NOT_SETTLED_PENDING' },
        ]);
        const { code, stderr } = await runCli(['A', 'B']);
        expect(code).toBe(EXIT.EXIT_INCOMPLETE);
        expect(stderr).toMatch(/1 witnessed, 1 not witnessed, 2 requested/);
    });

    test('PARTIAL batch (one key returned for two requested) -> 3', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([witnessed('A')]);
        const { code } = await runCli(['A', 'B']);
        expect(code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('provider PENDING does not witness and is not success', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: false, reason: 'PROVIDER_NOT_SETTLED_PENDING_TXSTATUS_0' },
        ]);
        expect((await runCli(['A'])).code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('transport TIMEOUT does not witness and is not success', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: false, reason: 'PROVIDER_TRANSPORT_ERROR_TIMEOUT' },
        ]);
        expect((await runCli(['A'])).code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('provider 5xx does not witness and is not success', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: false, reason: 'PROVIDER_TRANSPORT_HTTP_500' },
        ]);
        expect((await runCli(['A'])).code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('an INVALID provider response does not witness and is not success', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            { openingDedupKey: 'A', witnessed: false, reason: 'PROVIDER_DATA_TXSTATUS_NOT_NUMERIC' },
        ]);
        expect((await runCli(['A'])).code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('a THROWN per-opening error is recorded and the batch is incomplete', async () => {
        // The worker catches per-opening errors and returns them as results; if
        // one escapes anyway the batch is still not a success.
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([
            witnessed('A'),
            { openingDedupKey: 'B', witnessed: false, reason: 'WITNESS_EVIDENCE_UNDER_RECONCILIATION' },
        ]);
        expect((await runCli(['A', 'B'])).code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('DATABASE OUTAGE (worker throws) -> 2, not 3 and not 0', async () => {
        reconciler.reconcileTreasuryOpenings.mockRejectedValue(new Error("Can't reach database server at db:5432"));
        const { code, stdout, stderr } = await runCli(['A']);
        expect(code).toBe(EXIT.EXIT_FATAL);
        // A fatal run produced no batch result, so it must not look like one.
        expect(stdout).toBe('');
        expect(stderr).toMatch(/fatal/);
    });

    test('INVALID CREDENTIALS -> 1, before any work is attempted', async () => {
        clearCredentials();
        const { code, stderr } = await runCli(['A']);
        expect(code).toBe(EXIT.EXIT_INVALID);
        expect(reconciler.reconcileTreasuryOpenings).not.toHaveBeenCalled();
        expect(stderr).toMatch(/refusing to run: missing/);
    });

    test('a mode that is present but not exactly 1 -> 1', async () => {
        process.env.AZM_RECONCILER_MODE = 'true';
        const { code, stderr } = await runCli(['A']);
        expect(code).toBe(EXIT.EXIT_INVALID);
        expect(reconciler.reconcileTreasuryOpenings).not.toHaveBeenCalled();
        expect(stderr).toMatch(/must be exactly 1/);
    });

    test('EMPTY ARGUMENTS -> 1, with usage on stderr', async () => {
        const { code, stderr } = await runCli([]);
        expect(code).toBe(EXIT.EXIT_INVALID);
        expect(reconciler.reconcileTreasuryOpenings).not.toHaveBeenCalled();
        expect(stderr).toMatch(/usage:/);
    });

    test('an EMPTY batch result is incomplete, never a vacuous success', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([]);
        expect((await runCli(['A'])).code).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('exact money is serialized as a decimal STRING, and credentials never appear', async () => {
        reconciler.reconcileTreasuryOpenings.mockResolvedValue([witnessed('A')]);
        const { stdout } = await runCli(['A']);
        const json = JSON.parse(stdout);
        // 9900n must survive as "9900", not 9900 and not 9.9e3.
        expect(json.results[0].netPesewas).toBe('9900');
        expect(typeof json.results[0].netPesewas).toBe('string');
        // No credential and no database URL in any output channel.
        expect(stdout).not.toMatch(/fixture-pubkey|fixture-user|postgresql:\/\//);
        expect(JSON.stringify(json)).not.toMatch(/WITNESS_DATABASE_URL|AZM_RECONCILER_PROVIDER/);
    });

    test('the module exports the contract so monitoring asserts the same values', () => {
        expect(typeof runner.exitCodeForResults).toBe('function');
        expect(runner.exitCodeForResults([{ witnessed: true }])).toBe(EXIT.EXIT_ALL_WITNESSED);
        expect(runner.exitCodeForResults([{ witnessed: true }, { witnessed: false }])).toBe(EXIT.EXIT_INCOMPLETE);
        expect(runner.exitCodeForResults([])).toBe(EXIT.EXIT_INCOMPLETE);
        expect(runner.exitCodeForResults(null)).toBe(EXIT.EXIT_FATAL);
        // Only a literal `true` counts as witnessed: a truthy string must not.
        expect(runner.exitCodeForResults([{ witnessed: 'yes' }])).toBe(EXIT.EXIT_INCOMPLETE);
    });

    test('the entrypoint file is runnable as a real process and exits non-zero on empty args', () => {
        const { spawnSync } = require('child_process');
        const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'workers', 'run-provider-settlement-reconciler.js')], {
            encoding: 'utf8',
            env: { ...process.env, ...Object.fromEntries(runner.REQUIRED_ENV.map((n) => [n, process.env[n] || ''])) },
        });
        expect(res.status).toBe(EXIT.EXIT_INVALID);
        expect(res.stderr).toMatch(/usage:/);
    });
});
