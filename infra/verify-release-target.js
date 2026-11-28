#!/usr/bin/env node
'use strict';

// =============================================================================
// First step of the release chain: refuse to apply production DDL from an
// untrusted context. Exits non-zero, so `&&` stops the chain before the first
// installer runs and before the new version can receive traffic.
//
// Never prints the database URL.
// =============================================================================

const { evaluateReleaseTarget } = require('./lib/releaseTargetGuard');

function main() {
    const verdict = evaluateReleaseTarget(process.env);
    const line = `[release-target] ${verdict.code} (${verdict.context}` +
        `${verdict.branch ? `, branch ${verdict.branch}` : ''}` +
        `${verdict.target ? `, target ${verdict.target}` : ''}): ${verdict.reason}`;
    if (verdict.allowed) {
        console.log(line);
        return 0;
    }
    console.error(line);
    console.error('[release-target] refusing to run the release chain. No installer was executed.');
    return 1;
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { main };
