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
const crypto = require('crypto');
const {
    evaluateReleaseTarget,
    computeDeployAuthorizationToken,
    DEPLOY_AUTH,
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

// A TEST-ONLY keypair. The pinned production verification key is replaced for
// the duration of this suite; the real private key is held by the operator and
// is never in the repository.
const testKeyPair = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_PEM = testKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PINNED_PUBLIC_PEM = DEPLOY_AUTH.publicKeyPem;
const TEST_COMMIT = 'a9401446f2ce045b49e98ed2a935be5b190a1c1b';
/**
 * Mint a per-release authorization with THIS suite's keypair.
 * `now` can be shifted to model an expired or future-dated release.
 */
const mintToken = (over = {}) => {
    const issued = over.issuedAt ? Date.parse(over.issuedAt) : Date.now();
    return computeDeployAuthorizationToken(TEST_PRIVATE_PEM, {
        commit: TEST_COMMIT,
        issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + (over.ttlSeconds ?? 15 * 60) * 1000).toISOString(),
        ...over,
    });
};
const AUTH_TOKEN = mintToken();

beforeAll(() => { DEPLOY_AUTH.publicKeyPem = testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }); });
afterAll(() => { DEPLOY_AUTH.publicKeyPem = PINNED_PUBLIC_PEM; });

/** The complete identity tuple, exactly as Render would export it. */
const renderIdentity = (over = {}) => ({
    RENDER: 'true',
    IS_PULL_REQUEST: 'false',
    RENDER_GIT_BRANCH: 'main',
    RENDER_SERVICE_ID: APPROVED_PRODUCTION.serviceId,
    RENDER_GIT_COMMIT: TEST_COMMIT,
    DATABASE_URL: PROD_URL,
    ...over,
});

/** The same tuple plus the deploy authorization the approved service holds. */
const approvedDeploy = (over = {}) => renderIdentity({
    AZM_DEPLOY_AUTH_TOKEN: AUTH_TOKEN,
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

describe('the authorization is bound to ONE release', () => {
    test('a token for this exact service, branch, commit, database and window is allowed', () => {
        const v = evaluateReleaseTarget(approvedDeploy());
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_PRODUCTION');
    });

    test('an expired authorization is refused, even though it is otherwise perfect', () => {
        const issuedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const token = mintToken({ issuedAt, ttlSeconds: 15 * 60 });
        const v = evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: token }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_AUTH_EXPIRED');
    });

    test('a future-dated authorization is refused', () => {
        const issuedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const token = mintToken({ issuedAt });
        const v = evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: token }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_AUTH_NOT_YET_VALID');
    });

    test('a window longer than the maximum is refused', () => {
        const token = mintToken({ ttlSeconds: 2 * 60 * 60 });
        const v = evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: token }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_AUTH_WINDOW_TOO_LONG');
    });

    test('a token minted for another commit is refused on this deploy', () => {
        const token = mintToken({ commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
        const v = evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: token }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_AUTH_COMMIT');
    });

    test('a deploy with no commit identity cannot be authorized at all', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ RENDER_GIT_COMMIT: undefined }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_AUTH_COMMIT');
    });

    test('a token minted for another service, branch or database is refused', () => {
        const otherService = mintToken({ serviceId: 'srv-azaman-new' });
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: otherService })).code)
            .toBe('RELEASE_REFUSED_AUTH_SERVICE');

        const otherBranch = mintToken({ branch: 'feat/wp-l-business-currency-contract' });
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: otherBranch })).code)
            .toBe('RELEASE_REFUSED_AUTH_BRANCH');

        const otherDb = mintToken({ database: { host: 'ep-other-123.eu-west-2.aws.neon.tech', port: '5432', name: 'neondb' } });
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: otherDb })).code)
            .toBe('RELEASE_REFUSED_AUTH_DATABASE');
    });

    test('a corrupted signature or malformed payload is refused', () => {
        const good = mintToken();
        const [payloadPart, sigPart] = good.split('.');
        const flipped = Buffer.from(sigPart, 'base64url');
        flipped[0] ^= 0xff;
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: `${payloadPart}.${flipped.toString('base64url')}` })).code)
            .toBe('RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION');

        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: payloadPart })).code)
            .toBe('RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION');

        // A correctly signed payload in the OLD (v1) shape carries no release facts.
        const v1Payload = 'release:v1:srv-da1pvvrncjis73fru9fg:main';
        const v1Sig = crypto.sign(null, Buffer.from(v1Payload), TEST_PRIVATE_PEM);
        const v1Token = `${Buffer.from(v1Payload).toString('base64url')}.${v1Sig.toString('base64url')}`;
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: v1Token })).code)
            .toBe('RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION');
    });

    test('REPLAY SCOPE: the same token is accepted again for the same release, and for nothing else', () => {
        // Documented residual capability: no nonce store, so a valid token can be
        // replayed — but only for this service/branch/commit/database, and only
        // inside its window. It can never authorize a different release.
        const token = mintToken();
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: token })).allowed).toBe(true);
        expect(evaluateReleaseTarget(approvedDeploy({ AZM_DEPLOY_AUTH_TOKEN: token })).allowed).toBe(true);

        expect(evaluateReleaseTarget(approvedDeploy({
            AZM_DEPLOY_AUTH_TOKEN: token,
            RENDER_GIT_COMMIT: 'ffffffffffffffffffffffffffffffffffffffff',
        })).code).toBe('RELEASE_REFUSED_AUTH_COMMIT');
    });

    test('the signed payload never appears in the verdict', () => {
        const serialised = JSON.stringify(evaluateReleaseTarget(approvedDeploy()));
        expect(serialised).not.toContain(AUTH_TOKEN);
        expect(serialised).not.toContain(TEST_PRIVATE_PEM);
    });
});

describe('identity is not authorization: a forged Render tuple cannot release', () => {
    test('the complete forged tuple is refused for want of deploy authorization', () => {
        // Everything Render normally sets, exported by a local shell. The guard
        // cannot tell this apart from a real Render build by environment alone,
        // which is exactly why the authorization token exists.
        const forged = renderIdentity();
        const v = evaluateReleaseTarget(forged);
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_NO_DEPLOY_AUTHORIZATION');
    });

    test('a token minted with the wrong key is refused', () => {
        // A forger can generate its own keypair, but the guard verifies against
        // the key pinned in code, so the signature does not verify.
        const attacker = crypto.generateKeyPairSync('ed25519');
        const attackerToken = computeDeployAuthorizationToken(
            attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }),
            { commit: TEST_COMMIT },
        );
        const v = evaluateReleaseTarget(renderIdentity({ AZM_DEPLOY_AUTH_TOKEN: attackerToken }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION');
    });

    test('a token for a DIFFERENT service is not reusable against production', () => {
        const otherToken = computeDeployAuthorizationToken(TEST_PRIVATE_PEM, { serviceId: 'srv-azaman-new', commit: TEST_COMMIT });
        const v = evaluateReleaseTarget(renderIdentity({ AZM_DEPLOY_AUTH_TOKEN: otherToken }));
        expect(v.allowed).toBe(false);
        // Signed by the real key, but the payload names another service: the
        // release authorization is refused for exactly that reason.
        expect(v.code).toBe('RELEASE_REFUSED_AUTH_SERVICE');
    });

    test('the real authorization cannot leak into the verdict', () => {
        const serialised = JSON.stringify(evaluateReleaseTarget(approvedDeploy()));
        expect(serialised).not.toContain(AUTH_TOKEN);
        expect(serialised).not.toContain(TEST_PRIVATE_PEM);
    });
});

describe('malformed and parameterised URLs are refused, not interpreted', () => {
    test.each([
        ['empty database path', 'postgresql://u:pw@ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech:5432/'],
        ['malformed percent escape', 'postgresql://u:pw@ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech:5432/neondb%zz'],
        ['encoded path separator', 'postgresql://u:pw@ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech:5432/neondb%2Fevil'],
        ['hostile query parameter', `${PROD_URL}?options=-c%20search_path%3Devil`],
        ['non-public schema', `${PROD_URL}?schema=evil`],
        ['unknown pooler directive', `${PROD_URL}?pgbouncer=true`],
    ])('%s is refused', (_label, url) => {
        const v = evaluateReleaseTarget(approvedDeploy({ DATABASE_URL: url }));
        expect(v.allowed).toBe(false);
        expect([
            'RELEASE_REFUSED_NO_DATABASE',
            'RELEASE_REFUSED_WRONG_DATABASE',
            'RELEASE_REFUSED_UNEXPECTED_URL_PARAMETERS',
            'RELEASE_REFUSED_NON_PUBLIC_SCHEMA',
        ]).toContain(v.code);
        expect(JSON.stringify(v)).not.toContain('://');
    });

    test('an approved URL is still approved WITH the standard sslmode parameter', () => {
        const v = evaluateReleaseTarget(approvedDeploy({ DATABASE_URL: `${PROD_URL}?sslmode=require` }));
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_PRODUCTION');
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
        ['forged Render tuple', renderIdentity()],
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

    test('the CLI exits 0 for a permitted disposable target and non-zero for a forged tuple', () => {
        expect(verify({
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/azm_test',
            [TEST_TARGET_POLICY_ENV]: TEST_TARGET_POLICY_VALUE,
        }).status).toBe(0);

        // A child process verifies against the PINNED production key, which the
        // suite deliberately does not hold, so even the complete Render tuple is
        // refused there. The in-process test above covers the signed case with
        // this suite's own keypair.
        expect(verify(renderIdentity()).status).not.toBe(0);
        expect(verify(approvedDeploy()).status).not.toBe(0);
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
