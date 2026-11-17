// __tests__/release-target-guard-adversarial.test.js
// =============================================================================
// The release chain applies money and security DDL. So the guard is an
// allow-list proved from the OUTSIDE IN: every plausible wrong context is shown
// to be refused, and only the three legitimate ones are shown to pass. An
// absent identity is a refusal, never an assumed default — "no branch" is not
// "main", and a remote host is not production because it answers on 5432.
//
// The positive production fixture uses the REAL approved identity (service id,
// host, database name) with fake credentials: a generic host would prove
// nothing about the target we actually deploy to.
// =============================================================================
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
    evaluateReleaseTarget,
    APPROVED_PRODUCTION,
    TEST_TARGET_POLICY_ENV,
    TEST_TARGET_POLICY_VALUE,
} = require('../infra/lib/releaseTargetGuard');

const ROOT = path.resolve(__dirname, '..');
const CLI = 'infra/verify-release-target.js';

const SECRET = 'sup3r-s3cret-pw';
const USER = 'neondb_owner';
/** The approved production target, with credentials that are obviously fake. */
const PROD_URL = `postgresql://${USER}:${SECRET}@${APPROVED_PRODUCTION.databaseHost}:${APPROVED_PRODUCTION.databasePort}/${APPROVED_PRODUCTION.databaseName}`;

const approvedDeploy = (over = {}) => ({
    RENDER: 'true',
    IS_PULL_REQUEST: 'false',
    RENDER_GIT_BRANCH: 'main',
    RENDER_SERVICE_ID: APPROVED_PRODUCTION.serviceId,
    DATABASE_URL: PROD_URL,
    ...over,
});

const verify = (env) => {
    const res = spawnSync(process.execPath, [CLI], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
    });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
};

describe('refuses every wrong context', () => {
    test('a developer shell holding the real production DATABASE_URL', () => {
        const v = evaluateReleaseTarget({ DATABASE_URL: PROD_URL });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_PRODUCTION_DATABASE_OUTSIDE_RENDER');
    });

    test('a developer shell pointed at an arbitrary remote PostgreSQL', () => {
        const v = evaluateReleaseTarget({
            DATABASE_URL: 'postgresql://u:pw@db.example.com:5432/azm',
            [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
        });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_NON_DISPOSABLE_TARGET');
    });

    test('a remote database with no disposable-test policy at all', () => {
        const v = evaluateReleaseTarget({ DATABASE_URL: 'postgresql://u:pw@db.example.com:5432/azm' });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_TARGET_POLICY_MISSING');
    });

    test('a Render service that is not the approved AZM-backend service', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ RENDER_SERVICE_ID: 'srv-azaman-new-staging' }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_WRONG_SERVICE');
    });

    test('the approved service pointed at the wrong database host', () => {
        const v = evaluateReleaseTarget(approvedDeploy({
            DATABASE_URL: 'postgresql://u:pw@ep-other-branch-123456.eu-west-2.aws.neon.tech:5432/neondb',
        }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_WRONG_DATABASE');
    });

    test('the approved host with the wrong database name', () => {
        const v = evaluateReleaseTarget(approvedDeploy({
            DATABASE_URL: `postgresql://u:pw@${APPROVED_PRODUCTION.databaseHost}:5432/azam_new`,
        }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_WRONG_DATABASE');
    });

    test('an unapproved Neon branch of the same project', () => {
        const v = evaluateReleaseTarget(approvedDeploy({
            DATABASE_URL: `postgresql://u:pw@${APPROVED_PRODUCTION.databaseHost}:5432/neondb_branch_preview`,
        }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_WRONG_DATABASE');
    });

    test('a Render build on a branch other than main', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ RENDER_GIT_BRANCH: 'feat/wp-l-business-currency-contract' }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_BRANCH');
    });

    test('a Render build with no branch identity at all', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ RENDER_GIT_BRANCH: undefined }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_BRANCH_IDENTITY_MISSING');
    });

    test('a Render build with no service identity at all', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ RENDER_SERVICE_ID: undefined }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_SERVICE_IDENTITY_MISSING');
    });

    test('a pull-request preview build', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ IS_PULL_REQUEST: 'true' }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_PREVIEW');
    });

    test('a Render build where IS_PULL_REQUEST is simply absent', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ IS_PULL_REQUEST: undefined }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_PREVIEW_IDENTITY_MISSING');
    });

    test('a missing or ambiguous target identity', () => {
        expect(evaluateReleaseTarget({}).code).toBe('RELEASE_REFUSED_NO_DATABASE');
        expect(evaluateReleaseTarget(approvedDeploy({ DATABASE_URL: '' })).code).toBe('RELEASE_REFUSED_NO_DATABASE');
        // A URL that is not PostgreSQL at all is not a target we can reason about.
        expect(evaluateReleaseTarget(approvedDeploy({ DATABASE_URL: 'mysql://u:pw@host:3306/db' })).code)
            .toBe('RELEASE_REFUSED_NO_DATABASE');
        // A private address is not an identity, policy or not.
        expect(evaluateReleaseTarget({
            DATABASE_URL: 'postgresql://u:pw@172.18.0.2:5432/azm',
            [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
        }).code).toBe('RELEASE_REFUSED_NON_DISPOSABLE_TARGET');
    });

    test('a disposable target declared inside a production Node environment', () => {
        const v = evaluateReleaseTarget({
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://u:pw@localhost:5432/azm_test',
            [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
        });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_PRODUCTION_NODE_ENV');
    });
});

describe('allows exactly the legitimate contexts', () => {
    test('the approved production deploy', () => {
        const v = evaluateReleaseTarget(approvedDeploy());
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_PRODUCTION');
        expect(v.target).toBe('approved-production');
    });

    test('an explicitly permitted local development database', () => {
        const v = evaluateReleaseTarget({
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/azm_test',
            [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
        });
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_DISPOSABLE_TEST');
    });

    test('the actual disposable PostgreSQL CI service', () => {
        // CI runs against localhost:5432 (see .github/workflows/*), 127.0.0.1 is
        // the same host by another name, and both need the explicit policy.
        for (const host of ['localhost', '127.0.0.1']) {
            const v = evaluateReleaseTarget({
                DATABASE_URL: `postgresql://postgres:postgres@${host}:5432/azm_test`,
                [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
            });
            expect(v.allowed).toBe(true);
            expect(v.code).toBe('RELEASE_TARGET_DISPOSABLE_TEST');
        }
    });
});

describe('the guard is in the chain, and refusals are silent about credentials', () => {
    test('the guard is the first command, before every installer', () => {
        const chain = (require('../package.json').scripts.release || '').split('&&').map((x) => x.trim());
        expect(chain[0]).toBe(`node ${CLI}`);
        expect(chain.findIndex((c) => /infra\/install-/.test(c))).toBeGreaterThan(0);
    });

    test.each([
        ['production URL in a shell', { DATABASE_URL: PROD_URL }],
        ['preview build', approvedDeploy({ IS_PULL_REQUEST: 'true' })],
        ['wrong service', approvedDeploy({ RENDER_SERVICE_ID: 'srv-other' })],
        ['wrong database', approvedDeploy({ DATABASE_URL: 'postgresql://u:pw@other.host:5432/neondb' })],
        ['missing identity', {}],
    ])('no refusal leaks credentials or a URL (%s)', (_label, env) => {
        const verdict = evaluateReleaseTarget(env);
        expect(verdict.allowed).toBe(false);
        const serialised = JSON.stringify(verdict);
        for (const secret of [SECRET, USER, '://', APPROVED_PRODUCTION.databaseHost, APPROVED_PRODUCTION.databaseName]) {
            expect(serialised).not.toContain(secret);
        }

        // Same proof through the real CLI, which is what writes the build log.
        const cli = verify(env);
        expect(cli.status).not.toBe(0);
        expect(cli.stderr).toMatch(/RELEASE_REFUSED_|RELEASE_TARGET_/);
        for (const secret of [SECRET, USER, '://', APPROVED_PRODUCTION.databaseHost]) {
            expect(cli.stderr).not.toContain(secret);
            expect(cli.stdout).not.toContain(secret);
        }
    });

    test('the CLI exits 0 only for the approved deploy and a permitted disposable target', () => {
        expect(verify(approvedDeploy()).status).toBe(0);
        expect(verify({
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/azm_test',
            [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
        }).status).toBe(0);
    });
});

describe('the pinned identity is the documented identity', () => {
    const runbook = require('fs').readFileSync(path.join(ROOT, 'DEPLOY_RUNBOOK.md'), 'utf8');

    test('the approved service id, host and database name appear in the runbook', () => {
        // Drift detector: the guard pins an exact target, so the operator-facing
        // document must name the same one. If either changes alone, this fails.
        expect(runbook).toContain(APPROVED_PRODUCTION.serviceId);
        expect(runbook).toContain(APPROVED_PRODUCTION.databaseHost);
        expect(runbook).toContain(APPROVED_PRODUCTION.databaseName);
    });
});
