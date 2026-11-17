// __tests__/release-execution-path.test.js
// =============================================================================
// Where does production schema come from, and can anything untrusted trigger it?
//
// On the Free plan Render does not execute a Pre-Deploy Command, so a
// `preDeployCommand: npm run release` put the whole schema chain in a place
// that never runs. That is a silent, total schema failure — every table the
// release creates simply never appears. This file pins the deployment path,
// the ordering, the guard and the documentation to the verified live
// configuration, so a future edit cannot quietly move production DDL into a
// path that does not execute, or into a path anyone can trigger.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluateReleaseTarget } = require('../infra/lib/releaseTargetGuard');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PROD_URL = 'postgresql://user:sup3r-s3cret-pw@db.production.example:5432/azm';
const LOCAL_URL = 'postgresql://user:sup3r-s3cret-pw@localhost:5432/azm_test';

const renderEnv = (over = {}) => ({
    RENDER: 'true',
    RENDER_SERVICE_ID: 'srv-test',
    RENDER_GIT_BRANCH: 'main',
    DATABASE_URL: PROD_URL,
    ...over,
});

/** Every command in the release chain, in order. */
function releaseChain() {
    const release = (JSON.parse(read('package.json')).scripts || {}).release || '';
    return release.split('&&').map((s) => s.trim()).filter(Boolean);
}

describe('release target guard — fail closed', () => {
    test('a pull-request preview build may never apply production DDL', () => {
        const v = evaluateReleaseTarget(renderEnv({ IS_PULL_REQUEST: 'true' }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_PREVIEW');
    });

    test('a branch deploy other than main is refused', () => {
        const v = evaluateReleaseTarget(renderEnv({ RENDER_GIT_BRANCH: 'feat/wp-l-business-currency-contract' }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_BRANCH');
        expect(v.branch).toBe('feat/wp-l-business-currency-contract');
    });

    test('a missing database URL is refused rather than assumed', () => {
        const v = evaluateReleaseTarget(renderEnv({ DATABASE_URL: '' }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_NO_DATABASE');
    });

    test.each([
        ['localhost', LOCAL_URL],
        ['127.0.0.1', 'postgresql://u:p@127.0.0.1:5432/azm'],
        ['a .local host', 'postgresql://u:p@postgres.local:5432/azm'],
        ['an .internal host', 'postgresql://u:p@db.internal:5432/azm'],
    ])('a non-production target (%s) is refused', (_label, url) => {
        const v = evaluateReleaseTarget(renderEnv({ DATABASE_URL: url }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('RELEASE_REFUSED_NON_PRODUCTION_TARGET');
    });

    test('the trusted production deploy is allowed', () => {
        const v = evaluateReleaseTarget(renderEnv());
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_PRODUCTION');
    });

    test('outside Render the chain stays a local tool, so dev and CI keep working', () => {
        const v = evaluateReleaseTarget({ DATABASE_URL: LOCAL_URL });
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_LOCAL_CONTEXT');
    });

    test('holding Render credentials does not make a shell a deploy environment', () => {
        // A developer shell (or a CI job) with RENDER_API_KEY / RENDER_SERVICE_ID
        // exported is NOT a Render build. Refusing there would break local
        // releases while protecting nothing: Render sets RENDER=true itself.
        const v = evaluateReleaseTarget({
            RENDER_SERVICE_ID: 'srv-from-a-credential-shell',
            RENDER_API_KEY: 'not-a-deploy',
            DATABASE_URL: LOCAL_URL,
        });
        expect(v.allowed).toBe(true);
        expect(v.code).toBe('RELEASE_TARGET_LOCAL_CONTEXT');
    });

    test('a verdict can never leak the connection string', () => {
        // The guard is what gets logged on refusal. If it echoed the URL, every
        // refused build would print a production credential into build logs.
        const verdicts = [
            evaluateReleaseTarget(renderEnv()),
            evaluateReleaseTarget(renderEnv({ IS_PULL_REQUEST: 'true' })),
            evaluateReleaseTarget(renderEnv({ DATABASE_URL: LOCAL_URL })),
            evaluateReleaseTarget(renderEnv({ DATABASE_URL: '' })),
        ];
        for (const verdict of verdicts) {
            const serialised = JSON.stringify(verdict);
            expect(serialised).not.toContain('sup3r-s3cret-pw');
            expect(serialised).not.toContain('db.production.example');
        }
    });
});

describe('release target guard is wired into the chain itself', () => {
    const CLI = 'node infra/verify-release-target.js';

    test('the guard is the first command in the release chain', () => {
        expect(releaseChain()[0]).toBe(CLI);
    });

    test('the guard runs before every installer', () => {
        const chain = releaseChain();
        const guardAt = chain.indexOf(CLI);
        const firstInstallerAt = chain.findIndex((c) => /infra\/install-/.test(c));
        expect(guardAt).toBe(0);
        expect(guardAt).toBeLessThan(firstInstallerAt);
    });

    test('the guard exits non-zero on a preview and leaves the chain unrun', () => {
        const res = spawnSync(process.execPath, ['infra/verify-release-target.js'], {
            cwd: ROOT,
            env: { ...process.env, ...renderEnv({ IS_PULL_REQUEST: 'true' }) },
            encoding: 'utf8',
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/RELEASE_REFUSED_PREVIEW/);
        expect(res.stderr).toMatch(/No installer was executed/);
        expect(res.stderr).not.toContain('sup3r-s3cret-pw');
    });

    test('the guard exits zero on the trusted production deploy', () => {
        const res = spawnSync(process.execPath, ['infra/verify-release-target.js'], {
            cwd: ROOT,
            env: { ...process.env, ...renderEnv() },
            encoding: 'utf8',
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/RELEASE_TARGET_PRODUCTION/);
        expect(res.stdout).not.toContain('sup3r-s3cret-pw');
    });
});

describe('release chain — failure stops it before traffic', () => {
    test('the chain is one fail-fast && sequence with no ; separators', () => {
        const release = JSON.parse(read('package.json')).scripts.release;
        expect(release).not.toMatch(/;\s*node/);
        expect(release.split('&&').length).toBeGreaterThan(20);
    });

    test('authority verification is last, so nothing is appended after the gate', () => {
        const chain = releaseChain();
        expect(chain[chain.length - 1]).toBe('node infra/verify-authority-boundary.js');
        expect(chain.filter((c) => c.includes('verify-authority-boundary'))).toHaveLength(1);
    });

    test('the witness table is created before the backfill that reads it', () => {
        const chain = releaseChain();
        const witnessAt = chain.findIndex((c) => c.includes('install-wp-i-settlement-witness'));
        const claimAt = chain.findIndex((c) => c.includes('install-provider-observation-claim'));
        expect(witnessAt).toBeGreaterThan(-1);
        expect(claimAt).toBeGreaterThan(witnessAt);
    });

    test('the TOTP claim installer follows the provider-observation claim', () => {
        const chain = releaseChain();
        const providerAt = chain.findIndex((c) => c.includes('install-provider-observation-claim'));
        const totpAt = chain.findIndex((c) => c.includes('install-app-unlock-totp-claim'));
        expect(totpAt).toBeGreaterThan(providerAt);
    });

    test('the WP-I provenance role grant stays an operator procedure, not a deploy step', () => {
        expect(releaseChain().some((c) => /provenance/i.test(c))).toBe(false);
    });

    test('schema provisioning activates no authority and starts no reconciliation', () => {
        const chain = releaseChain();
        expect(chain.some((c) => /activati|enforce-authority|provider-reconcil/i.test(c))).toBe(false);
    });
});

describe('render.yaml matches the verified live Free-plan service', () => {
    const yaml = read('render.yaml');
    const serviceBlock = yaml.slice(yaml.indexOf('services:'));

    test('the plan is free, as the live service actually is', () => {
        expect(serviceBlock).toMatch(/^\s*plan:\s*free\s*$/m);
        expect(serviceBlock).not.toMatch(/^\s*plan:\s*starter\s*$/m);
    });

    test('the build command runs the full release chain once', () => {
        const build = /^\s*buildCommand:\s*(.+)$/m.exec(serviceBlock)[1].trim();
        expect(build).toContain('npm install');
        expect(build).toContain('npm run build');
        expect(build).toContain('npm run release');
        expect(build.match(/npm run release/g)).toHaveLength(1);
        // The whole chain, not a hand-picked subset of installers.
        expect(build).not.toMatch(/node infra\/install-/);
    });

    test('no pre-deploy command is declared, because Free would not run it', () => {
        expect(serviceBlock).not.toMatch(/^\s*preDeployCommand:/m);
    });

    test('release never runs through both build and pre-deploy', () => {
        const buildHasRelease = /^\s*buildCommand:.*npm run release/m.test(serviceBlock);
        const preDeploy = /^\s*preDeployCommand:\s*(.+)$/m.exec(serviceBlock);
        const preDeployHasRelease = Boolean(preDeploy && /npm run release/.test(preDeploy[1]));
        expect(buildHasRelease === true && preDeployHasRelease === false).toBe(true);
    });

    test('deploys stay manual and the start command matches the live service', () => {
        expect(serviceBlock).toMatch(/^\s*autoDeploy:\s*false\s*$/m);
        expect(serviceBlock).toMatch(/^\s*branch:\s*main\s*$/m);
        expect(serviceBlock).toMatch(/^\s*startCommand:\s*node index\.js\s*$/m);
    });
});

describe('boot path is not a schema barrier and must not take these authorities', () => {
    const autoRelease = read('infra/autoRelease.js');

    test('none of the four money/auth authorities is provisioned at boot', () => {
        for (const installer of [
            'install-provider-observation-claim',
            'install-wp-i-settlement-witness',
            'install-app-unlock-totp-claim',
            'install-action-step-up-grant',
        ]) {
            expect(autoRelease).not.toContain(installer);
        }
    });

    test('the offered-categories overlay runs before the seed-convergence early return', () => {
        // It is a SCHEMA overlay, so it must not be gated on the seed having
        // converged. It used to sit after that return, which meant it never ran
        // again once the treasury existed — i.e. on every real production boot.
        const overlayAt = autoRelease.indexOf('installBusinessOfferedCategoriesOverlay');
        const earlyReturnAt = autoRelease.indexOf('if (alreadySeeded && !force)');
        expect(overlayAt).toBeGreaterThan(-1);
        expect(earlyReturnAt).toBeGreaterThan(-1);
        expect(overlayAt).toBeLessThan(earlyReturnAt);
    });
});

describe('the runbook describes the deployment that actually exists', () => {
    const runbook = read('DEPLOY_RUNBOOK.md');

    test('it documents the 31-installer chain and the verified build command', () => {
        expect(runbook).toMatch(/31-step release chain/);
        expect(runbook).toContain('npm install && npm run build && npm run release');
        expect(runbook).toContain('infra/verify-release-target.js');
    });

    test('it no longer repeats the stale counts it used to claim', () => {
        expect(runbook).not.toMatch(/18-installer/);
        expect(runbook).not.toMatch(/fifteen installers/);
        expect(runbook).not.toMatch(/Push to main → Render runs/);
    });

    test('it names the four authorities that boot does not provision', () => {
        for (const table of [
            'ProviderSettlementWitness',
            'ProviderObservationClaim',
            'AppUnlockTotpClaim',
            'ActionStepUpGrant',
        ]) {
            expect(runbook).toContain(table);
        }
        expect(runbook).toMatch(/Not provisioned at boot/);
    });

    test('the documented step count matches the real chain', () => {
        // 31 release steps behind the guard: 30 install-* scripts plus the
        // susu foundation seed. Counted explicitly so the runbook's number
        // cannot drift away from package.json unnoticed.
        const steps = releaseChain().filter((c) => !/verify-release-target/.test(c));
        expect(steps).toHaveLength(31);
        expect(steps.filter((c) => /infra\/install-/.test(c))).toHaveLength(29);
        expect(steps.filter((c) => /seed-susu-foundation/.test(c))).toHaveLength(1);
        expect(steps.filter((c) => /verify-authority-boundary/.test(c))).toHaveLength(1);
    });
});
