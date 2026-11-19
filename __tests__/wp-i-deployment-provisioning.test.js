'use strict';

/**
 * WP-I — the reconciler must be startable, and its table must exist on a clean
 * production database.
 *
 * These are two defects that local unit tests could not see:
 *
 *  1. The operator entrypoint listed its two provider credentials as ONE
 *     combined string, so process.env[...] for that entry was always undefined
 *     and the process could never start. The existing test deleted each name in
 *     REQUIRED_ENV and expected a refusal — deleting a name that is not set is a
 *     no-op, so the bug was invisible. The only honest test runs the real
 *     process with a complete environment.
 *
 *  2. Render's release command does not run Prisma migrations. The fiat
 *     liquidity overlay backfills from "ProviderSettlementWitness", and nothing
 *     in the release path created it, so a clean release died on that statement.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'workers', 'run-provider-settlement-reconciler.js');

const DATABASE_URL = process.env.DATABASE_URL;

/** Run the real entrypoint as a separate process, exactly as an operator would. */
function runCli(args, env) {
    const child = spawnSync(process.execPath, [CLI, ...args], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, NODE_ENV: 'test', ...env },
        encoding: 'utf8',
        timeout: 60000,
    });
    return { code: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

const COMPLETE_ENV = {
    AZM_RECONCILER_MODE: '1',
    AZM_RECONCILER_PROVIDER_USER: 'test-user',
    AZM_RECONCILER_PROVIDER_PUBKEY: 'test-public-key',
    WITNESS_DATABASE_URL: DATABASE_URL,
    WITNESS_ACCOUNT_CURRENCY_MAP: JSON.stringify({ 'WALLET-TEST-1': 'GHS' }),
};

describe('WP-I reconciler operator entrypoint', () => {
    test('the required-environment list names variables, never a combined expression', () => {
        const runner = require(path.join(ROOT, 'workers', 'run-provider-settlement-reconciler.js'));
        expect(Array.isArray(runner.REQUIRED_ENV)).toBe(true);
        expect(runner.REQUIRED_ENV.length).toBeGreaterThanOrEqual(5);
        for (const name of runner.REQUIRED_ENV) {
            // A single identifier: no operators, no spaces, no punctuation.
            expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
        expect(runner.REQUIRED_ENV).toEqual(expect.arrayContaining([
            'AZM_RECONCILER_PROVIDER_USER',
            'AZM_RECONCILER_PROVIDER_PUBKEY',
        ]));
    });

    test('a missing usage argument is refused before any credential is read', () => {
        const r = runCli([], COMPLETE_ENV);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/usage:/);
    });

    test('an empty environment is refused and every variable is named', () => {
        const r = runCli(['OPENING-TEST-1'], {});
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/missing/);
        expect(r.stderr).toContain('AZM_RECONCILER_PROVIDER_USER');
        expect(r.stderr).toContain('AZM_RECONCILER_PROVIDER_PUBKEY');
        expect(r.stderr).toContain('WITNESS_DATABASE_URL');
    });

    // Each credential is refused INDEPENDENTLY. The old combined-name defect
    // would pass a "delete one variable" test while the process stayed dead.
    test.each([
        ['AZM_RECONCILER_MODE'],
        ['AZM_RECONCILER_PROVIDER_USER'],
        ['AZM_RECONCILER_PROVIDER_PUBKEY'],
        ['WITNESS_DATABASE_URL'],
        ['WITNESS_ACCOUNT_CURRENCY_MAP'],
    ])('removing %s alone stops the run and names that variable', (name) => {
        const env = { ...COMPLETE_ENV };
        delete env[name];
        const r = runCli(['OPENING-TEST-1'], env);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(name);
    });

    test('a mode that is present but not 1 does not open the writer guard', () => {
        // Non-empty values are present-but-wrong: refused on the VALUE.
        for (const value of ['0', 'true', 'yes', '2']) {
            const r = runCli(['OPENING-TEST-1'], { ...COMPLETE_ENV, AZM_RECONCILER_MODE: value });
            expect(r.code).toBe(1);
            expect(r.stderr).toMatch(/must be exactly 1/);
        }
        // An empty value is not a mode at all: refused as missing, which is the
        // same outcome by the stricter route.
        const empty = runCli(['OPENING-TEST-1'], { ...COMPLETE_ENV, AZM_RECONCILER_MODE: '' });
        expect(empty.code).toBe(1);
        expect(empty.stderr).toMatch(/missing AZM_RECONCILER_MODE/);
    });

    test('with a complete environment the process actually starts and reports per-opening truth', () => {
        const r = runCli(['OPENING-DOES-NOT-EXIST'], COMPLETE_ENV);
        // §6 exit contract: an opening that did not receive a witness is NOT a
        // successful reconciliation. This assertion used to expect 0, which is
        // precisely the defect — a scheduler read "nothing witnessed" as success.
        expect(r.code).toBe(3);
        expect(r.stderr).toMatch(/were NOT witnessed/);
        const out = JSON.parse(r.stdout);
        expect(Array.isArray(out.results)).toBe(true);
        expect(out.results[0].witnessed).toBe(false);
        // No opening means no provider call and no witness of any kind.
        expect(out.results[0].reason).toBeTruthy();
        expect(out.results[0].reason).not.toMatch(/OPENING_DOES_NOT_EXIST/);
    }, 60000);
});

describe('WP-I witness table provisioning through the release chain', () => {
    const release = require(path.join(ROOT, 'package.json')).scripts.release;

    test('the witness overlay runs BEFORE the installer that reads the table', () => {
        const witness = release.indexOf('install-wp-i-settlement-witness.js');
        const reader = release.indexOf('install-fiat-liquidity-overlay.js');
        expect(witness).toBeGreaterThan(-1);
        expect(reader).toBeGreaterThan(-1);
        expect(witness).toBeLessThan(reader);
    });

    test('no release installer references the witness table before it is created', () => {
        const steps = release.split('&&').map((s) => s.trim()).filter(Boolean);
        const createdAt = steps.findIndex((s) => s.includes('install-wp-i-settlement-witness.js'));
        const infra = path.join(ROOT, 'infra');
        const referrers = fs.readdirSync(infra)
            .filter((f) => f.endsWith('.js'))
            .filter((f) => /ProviderSettlementWitness/.test(fs.readFileSync(path.join(infra, f), 'utf8')))
            .map((f) => f.replace(/\.js$/, ''));
        for (const referrer of referrers) {
            if (referrer === 'install-wp-i-settlement-witness') continue;
            const at = steps.findIndex((s) => s.includes(referrer));
            if (at === -1) continue; // not in the chain at all
            expect(at).toBeGreaterThan(createdAt);
        }
    });

    test('the overlay installer creates the table, columns and indexes, and is safe to repeat', () => {
        const installer = path.join(ROOT, 'infra', 'install-wp-i-settlement-witness.js');
        const env = { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL };
        const first = spawnSync(process.execPath, [installer], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
        expect(first.status).toBe(0);
        expect(first.stdout).toMatch(/verified \d+ columns and \d+ indexes/);

        const second = spawnSync(process.execPath, [installer], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
        expect(second.status).toBe(0);
        expect(second.stdout).toMatch(/verified \d+ columns and \d+ indexes/);
    }, 180000);
});
