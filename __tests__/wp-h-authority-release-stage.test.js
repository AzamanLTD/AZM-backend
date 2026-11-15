// §WP-H C10/I.7 — a release must never provision a security boundary, and an
// absent boundary must not fail a deploy that cannot be enforced yet.
'use strict';

const path = require('path');
const fs = require('fs');

jest.mock('../src/services/authorityActivationEnforcement', () => {
    const actual = jest.requireActual('../src/services/authorityActivationEnforcement');
    return {
        ...actual,
        inspectEnforcement: jest.fn(),
    };
});

const enforcement = require('../src/services/authorityActivationEnforcement');
const { verifyAuthorityBoundary } = require('../infra/verify-authority-boundary');

const ROOT = path.join(__dirname, '..');

const inspectAs = (problems) => enforcement.inspectEnforcement.mockResolvedValue({
    established: problems.length === 0, problems, diagnostics: {}, row: null,
});

describe('WP-H release-chain authority verification', () => {
    beforeEach(() => jest.clearAllMocks());

    test('the stage is wired last in the release chain and present in CI', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const chain = pkg.scripts.release.split(' && ').map((s) => s.trim());
        expect(chain[chain.length - 1]).toBe('node infra/verify-authority-boundary.js');

        const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
        expect(wf).toContain('node infra/verify-authority-boundary.js');
    });

    test('the stage provisions nothing: it never issues DDL or grants', () => {
        const src = fs.readFileSync(path.join(ROOT, 'infra/verify-authority-boundary.js'), 'utf8');
        for (const forbidden of ['CREATE ', 'ALTER ', 'GRANT ', 'DROP ', 'INSERT INTO', 'REVOKE ']) {
            expect(src).not.toContain(forbidden);
        }
    });

    test('an absent boundary passes and says provisioning is a DBA action', async () => {
        inspectAs([enforcement.PROBLEM.TABLE_MISSING]);
        const log = jest.fn();
        const r = await verifyAuthorityBoundary({}, { log });
        expect(r.verdict).toBe('ABSENT');
        expect(r.ok).toBe(true);
        expect(log.mock.calls.flat().join(' ')).toMatch(/Provisioning is a DBA action/);
    });

    test('an absent boundary FAILS under --strict (use once the split is done)', async () => {
        inspectAs([enforcement.PROBLEM.TABLE_MISSING]);
        const r = await verifyAuthorityBoundary({}, { strict: true });
        expect(r.verdict).toBe('ABSENT_STRICT');
        expect(r.ok).toBe(false);
    });

    test('a sound boundary passes', async () => {
        inspectAs([]);
        const r = await verifyAuthorityBoundary({}, {});
        expect(r.verdict).toBe('SOUND');
        expect(r.ok).toBe(true);
    });

    test('drift fails the release', async () => {
        inspectAs([enforcement.PROBLEM.RUNTIME_IS_SUPERUSER]);
        const r = await verifyAuthorityBoundary({}, {});
        expect(r.verdict).toBe('DRIFT');
        expect(r.ok).toBe(false);
    });

    test('a probe failure is UNVERIFIABLE, never treated as absent', async () => {
        inspectAs([enforcement.PROBLEM.ENFORCEMENT_PROBE_FAILED]);
        const r = await verifyAuthorityBoundary({}, {});
        expect(r.verdict).toBe('UNVERIFIABLE');
        expect(r.ok).toBe(false);
    });
});
