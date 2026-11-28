#!/usr/bin/env node
// infra/verify-authority-boundary.js
// =============================================================================
// §WP-H — release-chain VERIFICATION of the authority boundary.
//
// This stage provisions NOTHING. It exists because 'npm run release' must not
// silently create or alter a security boundary (C10/I.7): roles, ownership,
// grants and the SECURITY DEFINER function are a DBA action with their own
// installer and their own credentials.
//
// It answers one question per deploy: is the boundary, IF it exists, still
// sound? Absent boundary => exit 0 with an explicit notice, because a database
// that has not been split yet cannot be enforced and must not fail its deploy.
// Present but broken => exit 1, so drift stops the release instead of shipping.
//
//   --strict   treat an ABSENT boundary as a failure (use once the split is done)
// =============================================================================
'use strict';

const { inspectEnforcement, PROBLEM } = require('../src/services/authorityActivationEnforcement');

// Absence is a known, documented state (production has not been split yet). It is
// distinct from "present and wrong", which is drift and must stop the release.
const ABSENT_PROBLEMS = new Set([PROBLEM.TABLE_MISSING]);

// The protected TABLE comes from the schema, not from the role installer, so a
// database can easily have the table and NOTHING else. That is not drift: it is a
// database where the boundary was never installed.
const NEVER_INSTALLED = [PROBLEM.TRIGGER_FUNCTION_MISSING, PROBLEM.ACTIVATION_FUNCTION_MISSING];

// The connection split is the prerequisite for all of this. While the runtime is
// a superuser or the table owner, enforcement is impossible by construction, so
// "not provisioned" is the honest verdict and the deploy must not be blocked.
// Once the split lands these two go false and every missing object becomes drift.
// The SESSION identity belongs in this family for the same reason: a privileged
// login that merely assumed the runtime role is the connection split NOT having
// happened, which is "not provisioned", not "present and wrong". Without this the
// release-chain verifier reported DRIFT for a database that was never split
// (measured in CI on df1998e7).
const UNSPLIT = [
    PROBLEM.RUNTIME_IS_SUPERUSER,
    PROBLEM.RUNTIME_OWNS_TABLE,
    PROBLEM.SESSION_IDENTITY_PRIVILEGED,
    PROBLEM.RUNTIME_IDENTITY_ASSUMED,
];

async function verifyAuthorityBoundary(prisma, { strict = false, log = () => {} } = {}) {
    const result = await inspectEnforcement(prisma);
    const problems = Array.isArray(result.problems) ? result.problems : [];

    // A probe failure is NOT absence: we cannot tell what is there, so we refuse
    // to certify it. The release stays green only on a positively absent boundary.
    const probeFailed = problems.includes(PROBLEM.ENFORCEMENT_PROBE_FAILED);
    const absent = problems.length > 0 && problems.every((p) => ABSENT_PROBLEMS.has(p));
    const neverInstalled = NEVER_INSTALLED.every((p) => problems.includes(p));
    const unsplit = UNSPLIT.some((p) => problems.includes(p));

    let verdict;
    if (probeFailed) verdict = 'UNVERIFIABLE';
    else if (absent) verdict = strict ? 'ABSENT_STRICT' : 'ABSENT';
    else if (problems.length === 0) verdict = 'SOUND';
    else if (neverInstalled && unsplit) verdict = strict ? 'NOT_PROVISIONED_STRICT' : 'NOT_PROVISIONED';
    else verdict = 'DRIFT';

    if (verdict === 'ABSENT') {
        log('authority boundary is NOT provisioned. Provisioning is a DBA action:');
        log('  node infra/install-authority-activation-roles.js --owner=... --runtime=... --operator=...');
        log('  node infra/install-authority-activation-function.js --role-scoped');
        log('Nothing was created by this stage.');
    }
    if (verdict === 'NOT_PROVISIONED') {
        log('authority boundary EXISTS but was never provisioned: no guard triggers, no');
        log('activation function, and the runtime identity still owns the table.');
        log('Enforcement cannot be attested from this connection. This deploy proceeds');
        log('UNENFORCED. Provisioning is a DBA action:');
        log('  node infra/install-authority-activation-roles.js --owner=... --runtime=... --operator=...');
        log('  node infra/install-authority-activation-function.js --role-scoped');
    }
    if (verdict === 'ABSENT_STRICT') log('authority boundary is ABSENT and --strict was requested.');
    if (verdict === 'NOT_PROVISIONED_STRICT') log('authority boundary was never provisioned and --strict was requested.');
    if (verdict === 'SOUND') log('authority boundary is provisioned and sound.');
    if (verdict === 'DRIFT' || verdict === 'UNVERIFIABLE') {
        log(`authority boundary is ${verdict === 'DRIFT' ? 'DRIFTED' : 'UNVERIFIABLE'}: ${problems.join(', ')}`);
    }

    return {
        verdict,
        problems,
        ok: verdict === 'SOUND' || verdict === 'ABSENT' || verdict === 'NOT_PROVISIONED',
        diagnostics: result.diagnostics || null,
    };
}

module.exports = { verifyAuthorityBoundary };

if (require.main === module) {
    const { PrismaClient } = require('@prisma/client');
    const strict = process.argv.includes('--strict');
    const prisma = new PrismaClient();
    verifyAuthorityBoundary(prisma, { strict, log: (l) => console.log(`[authority-verify] ${l}`) })
        .then((r) => {
            console.log(JSON.stringify({ verdict: r.verdict, ok: r.ok, problems: r.problems }, null, 2));
            if (!r.ok) process.exitCode = 1;
        })
        .catch((err) => {
            // An unreachable database is not a boundary verdict; fail the stage so a
            // deploy never proceeds on an authority state nobody could read.
            console.error(`[authority-verify] FAILED: ${err.message}`);
            process.exitCode = 1;
        })
        .finally(async () => { await prisma.$disconnect(); });
}
