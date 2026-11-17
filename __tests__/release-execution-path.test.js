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

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');


/** Every command in the release chain, in order. */
function releaseChain() {
    const release = (JSON.parse(read('package.json')).scripts || {}).release || '';
    return release.split('&&').map((s) => s.trim()).filter(Boolean);
}

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

describe('the four money and security authorities are provisioned by the chain', () => {
    const chain = releaseChain();

    test.each([
        ['ProviderSettlementWitness', 'install-wp-i-settlement-witness.js'],
        ['ProviderObservationClaim', 'install-provider-observation-claim.js'],
        ['AppUnlockTotpClaim', 'install-app-unlock-totp-claim.js'],
        ['ActionStepUpGrant', 'install-action-step-up-grant.js'],
    ])('%s is created by exactly one release step', (_table, installer) => {
        expect(chain.filter((c) => c.includes(installer))).toHaveLength(1);
    });

    test('a failing installer stops the chain, because it is one && sequence', () => {
        const release = JSON.parse(read('package.json')).scripts.release;
        expect(release.split('&&').length).toBe(32);
        expect(release).not.toMatch(/\|\||;/);
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

describe('the runbook distinguishes the ACTUAL deployment from the PROPOSED one', () => {
    const runbook = read('DEPLOY_RUNBOOK.md');
    const ACTUAL_BUILD = 'npm install && npm run build && node infra/install-e2ee-server-blind-overlay.js';
    const PROPOSED_BUILD = 'npm install && npm run build && npm run release';
    const actualSection = runbook.slice(runbook.indexOf('ACTUAL live configuration'), runbook.indexOf('PROPOSED configuration'));
    const proposedSection = runbook.slice(runbook.indexOf('PROPOSED configuration'), runbook.indexOf('What runs where'));

    test('it records the ACTUAL live build command, which does not run the chain', () => {
        expect(actualSection).toContain(ACTUAL_BUILD);
        expect(actualSection).toMatch(/does NOT execute it|does not execute it/);
        expect(actualSection).toContain('48c17ab10248');
        expect(actualSection).toMatch(/`free`/);
        // The proposed command must NOT be presented as the live one.
        expect(actualSection).not.toContain(PROPOSED_BUILD);
    });

    test('it presents the full chain as PROPOSED and explicitly not applied', () => {
        expect(proposedSection).toContain(PROPOSED_BUILD);
        expect(proposedSection).toMatch(/NOT APPLIED/);
        expect(proposedSection).toMatch(/not live|Nothing in this section is live/);
        expect(proposedSection).toContain('verify-release-target.js');
    });

    test('it names the approved production identity the guard pins', () => {
        const { APPROVED_PRODUCTION } = require('../infra/lib/releaseTargetGuard');
        expect(runbook).toContain(APPROVED_PRODUCTION.serviceId);
        expect(runbook).toContain(APPROVED_PRODUCTION.databaseHost);
        expect(runbook).toContain(APPROVED_PRODUCTION.databaseName);
    });

    test('stale claims survive only inside the dated corrections section', () => {
        expect(runbook).not.toMatch(/Push to main → Render runs/);
        expect(runbook).not.toMatch(/fifteen installers/);
        const staleIndex = runbook.indexOf('18 installers');
        if (staleIndex !== -1) {
            // Only allowed where it is explicitly dated as a correction.
            expect(runbook).toMatch(/Historical statements, corrected/);
            expect(runbook.indexOf('Historical statements, corrected')).toBeLessThan(staleIndex);
        }
    });

    test('it documents the 31-step chain and the four authorities boot does not provision', () => {
        expect(runbook).toMatch(/31-step release chain/);
        for (const table of ['ProviderSettlementWitness', 'ProviderObservationClaim', 'AppUnlockTotpClaim', 'ActionStepUpGrant']) {
            expect(runbook).toContain(table);
        }
        expect(runbook).toMatch(/Not provisioned at boot/);
    });

    test('the quarantined-collision operator procedure is documented', () => {
        expect(runbook).toMatch(/QUARANTINE|quarantin/i);
        expect(runbook).toContain('OBSERVATION_QUARANTINED');
    });

    test('the documented step count matches the real chain', () => {
        const steps = releaseChain().filter((c) => !/verify-release-target/.test(c));
        expect(steps).toHaveLength(31);
        expect(steps.filter((c) => /infra\/install-/.test(c))).toHaveLength(29);
        expect(steps.filter((c) => /seed-susu-foundation/.test(c))).toHaveLength(1);
        expect(steps.filter((c) => /verify-authority-boundary/.test(c))).toHaveLength(1);
    });
});

describe('every document agrees on the chain and the production schema path', () => {
    test('the chain is 32 && segments: one guard plus 31 commands', () => {
        const chain = releaseChain(); // every && segment, guard included
        expect(chain).toHaveLength(32);
        expect(chain.filter((c) => !/verify-release-target/.test(c))).toHaveLength(31);
        expect(JSON.parse(read('package.json')).scripts.release.split('&&')).toHaveLength(32);
        expect(read('DEPLOY_RUNBOOK.md')).toMatch(/32 `&&` segments/);
        expect(read('DEPLOY_RUNBOOK.md')).toMatch(/31 commands/);
    });

    test('migrate deploy is never offered as a production instruction', () => {
        const wpI = read('docs/wp-i-reconciler-runbook.md');
        expect(wpI).toMatch(/NON-PRODUCTION/);
        const offender = wpI.split('\n').filter((l) => /prisma migrate deploy/.test(l))
            .filter((l) => !/NON-PRODUCTION|non-production|never run|against production/i.test(l));
        expect(offender).toEqual([]);
        // And the production schema contract stays stated in the deploy runbook.
        expect(read('DEPLOY_RUNBOOK.md')).toMatch(/`prisma migrate deploy` is NOT part/);
    });

    test('the production release chain requires a per-release, commit-bound authorization', () => {
        const runbook = read('DEPLOY_RUNBOOK.md');
        expect(runbook).toMatch(/Release authorization/);
        expect(runbook).toMatch(/AZM_DEPLOY_AUTH_TOKEN/);
        expect(runbook).toMatch(/RENDER_GIT_COMMIT/);
        expect(runbook).toMatch(/RELEASE_REFUSED_AUTH_COMMIT/);
        expect(runbook).toMatch(/RELEASE_REFUSED_AUTH_EXPIRED/);
        expect(runbook).toMatch(/NOT cryptographic proof that Render\s+started the\s+process/);
        // The replay scope must be stated, and must not be overstated.
        expect(runbook).toMatch(/NOT single-use authorization/);
        expect(runbook).not.toMatch(/one-time authorization/i);
        expect(read('render.yaml')).toMatch(/AZM_DEPLOY_AUTH_TOKEN/);
        expect(read('render.yaml')).toMatch(/RENDER_GIT_COMMIT/);
    });

    test('no workflow runs the production release chain against a non-production database', () => {
        const bootstrap = read('.github/workflows/bootstrap-azaman-new.yml');
        const runsRelease = bootstrap.split('\n').some((l) => /^\s*run:\s*(npm run release|node infra\/verify-release-target)/.test(l));
        expect(runsRelease).toBe(false);
        expect(bootstrap).toMatch(/separately reviewed, non-production provisioning path/);
    });
});

describe('render.yaml is labelled as proposed configuration', () => {
    const yaml = read('render.yaml');
    const header = yaml.slice(0, yaml.indexOf('services:'));
    // Comment lines are hard-wrapped; compare the unwrapped prose.
    const flat = header.replace(/^#\s?/gm, '').replace(/\s+/g, ' ');

    test('the file says it is proposed and not applied', () => {
        expect(flat).toMatch(/PROPOSED CONFIGURATION — NOT APPLIED/);
        expect(flat).toMatch(/Nothing in this file is a live setting/);
    });

    test('it preserves the warning not to sync the blueprint blindly', () => {
        expect(flat).toMatch(/Do NOT sync this blueprint into Render blindly/);
        expect(flat).toMatch(/differently-named service/);
    });

    test('it records the actual live build command separately from the proposed one', () => {
        expect(flat).toMatch(/buildCommand : npm install && npm run build && three overlay installers/);
        expect(flat).toMatch(/preDeployCommand: npm run release — CONFIGURED BUT NOT EXECUTED on Free/);
    });
});
