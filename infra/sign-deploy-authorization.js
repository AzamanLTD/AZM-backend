#!/usr/bin/env node
'use strict';

// =============================================================================
// Operator tool: mint a release authorization token.
//
// The release guard verifies AZM_DEPLOY_AUTH_TOKEN against a public key pinned in
// infra/lib/releaseTargetGuard.js. Only the holder of the matching PRIVATE key
// can produce a token, which is what makes the check meaningful: a shell that
// exports the complete forged Render tuple still cannot release production DDL.
//
// The token authorizes ONE release: the approved service, the canonical branch,
// the commit being deployed and the approved production database, with a short
// validity window (15 minutes by default, 60 at most).
//
// Usage:
//   node infra/sign-deploy-authorization.js --key /secure/path/azm-release-auth.key --commit <sha>
//   node infra/sign-deploy-authorization.js --key <path> --commit <sha> --ttl-minutes 10
//   AZM_DEPLOY_PRIVATE_KEY_FILE=<path> node infra/sign-deploy-authorization.js --commit <sha>
//
// --commit defaults to RENDER_GIT_COMMIT, then to `git rev-parse HEAD`.
// Put the printed token in the approved service's environment as
// AZM_DEPLOY_AUTH_TOKEN for the duration of THAT deploy, and remove it
// afterwards. Never commit the private key, and never paste either secret into a
// tracked file.
// =============================================================================

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
    computeDeployAuthorizationToken,
    deployAuthorizationPayload,
    DEPLOY_AUTH_MAX_WINDOW_SECONDS,
} = require('./lib/releaseTargetGuard');

const argOf = (name) => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
};

function main() {
    const keyPath = argOf('--key') || process.env.AZM_DEPLOY_PRIVATE_KEY_FILE;
    if (!keyPath) {
        console.error('[sign-deploy-authorization] provide --key <private key path> or AZM_DEPLOY_PRIVATE_KEY_FILE');
        process.exit(1);
    }

    let commit = argOf('--commit') || process.env.RENDER_GIT_COMMIT;
    if (!commit) {
        try {
            commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        } catch (_) {
            console.error('[sign-deploy-authorization] provide --commit <sha>: it cannot be inferred here');
            process.exit(1);
        }
    }
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
        console.error('[sign-deploy-authorization] --commit must be a full 40-character commit SHA');
        process.exit(1);
    }

    const ttlMinutes = Number(argOf('--ttl-minutes') || 15);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes * 60 > DEPLOY_AUTH_MAX_WINDOW_SECONDS) {
        console.error(`[sign-deploy-authorization] --ttl-minutes must be between 1 and ${DEPLOY_AUTH_MAX_WINDOW_SECONDS / 60}`);
        process.exit(1);
    }

    const pem = fs.readFileSync(keyPath, 'utf8');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60 * 1000);
    const token = computeDeployAuthorizationToken(pem, {
        commit,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
    });

    console.error(`[sign-deploy-authorization] commit=${commit}`);
    console.error(`[sign-deploy-authorization] payload=${deployAuthorizationPayload({ commit, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() })}`);
    console.error(`[sign-deploy-authorization] valid_from=${issuedAt.toISOString()} valid_until=${expiresAt.toISOString()}`);
    console.log(token);
}

if (require.main === module) {
    try { main(); } catch (e) { console.error('[sign-deploy-authorization] FAILED:', e.message); process.exit(1); }
}
