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
// Usage:
//   node infra/sign-deploy-authorization.js --key /secure/path/azm-release-auth.key
//   AZM_DEPLOY_PRIVATE_KEY_FILE=/secure/path/azm-release-auth.key node infra/sign-deploy-authorization.js
//
// Put the printed token in the approved service's environment as
// AZM_DEPLOY_AUTH_TOKEN. Never commit the private key, and never paste the token
// into a tracked file.
// =============================================================================

const fs = require('fs');
const { computeDeployAuthorizationToken, deployAuthorizationPayload } = require('./lib/releaseTargetGuard');

function main() {
    const idx = process.argv.indexOf('--key');
    const keyPath = idx !== -1 ? process.argv[idx + 1] : process.env.AZM_DEPLOY_PRIVATE_KEY_FILE;
    if (!keyPath) {
        console.error('[sign-deploy-authorization] provide --key <private key path> or AZM_DEPLOY_PRIVATE_KEY_FILE');
        process.exit(1);
    }
    const pem = fs.readFileSync(keyPath, 'utf8');
    const token = computeDeployAuthorizationToken(pem);
    console.error(`[sign-deploy-authorization] payload=${deployAuthorizationPayload()}`);
    console.log(token);
}

if (require.main === module) {
    try { main(); } catch (e) { console.error('[sign-deploy-authorization] FAILED:', e.message); process.exit(1); }
}
