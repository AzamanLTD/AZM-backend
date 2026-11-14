#!/usr/bin/env node
// scripts/p5d-authority-activate-enforced.js
// =============================================================================
// §WP-E — THE ONLY SANCTIONED WAY TO ACTIVATE THE ENFORCED AUTHORITY.
//
//   AUTHORITY_ACTIVATION_DATABASE_URL=... \
//   node scripts/p5d-authority-activate-enforced.js activate \
//     --activated-by <operator-name> \
//     --approved-by <approver-name> \
//     --evidence-reference <external evidence id> \
//     --evidence-digest <sha256 of that evidence>
//
//   node scripts/p5d-authority-activate-enforced.js status
//
// WHY A SEPARATE CONNECTION
// Activation must be performed by a database authority the application runtime
// does not hold: `AUTHORITY_ACTIVATION_DATABASE_URL` is the operator role's own
// credential and is never read by the application server. The runtime role must
// not be a member of it, and this script refuses to run if the connection it was
// given can UPDATE, DELETE or TRUNCATE the resulting record — that would mean
// the credential is not the narrow activation authority.
//
// WHAT AN ACTIVATION ROW IS NOT
// It is a CONTROL DECISION. It does not prove that customer money, GHS assets or
// provider receipts exist. A caller-supplied reference is not evidence, and a
// digest is only a fingerprint of evidence reviewable elsewhere. Real activation
// requires separately verified external evidence plus a named approver; the
// script records who decided, what they reviewed and when, and nothing more.
//
// Exit codes: 0 ok · 1 refused · 2 usage · 3 runtime error.
// =============================================================================
'use strict';

const { PrismaClient } = require('@prisma/client');
const enforcement = require('../src/services/authorityActivationEnforcement');

const ACTOR_RE = /^[A-Za-z0-9 ._@:-]{2,120}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/i;

function usage(message) {
    if (message) console.error(`\n${message}\n`);
    console.error(`Usage:
  AUTHORITY_ACTIVATION_DATABASE_URL=... node scripts/p5d-authority-activate-enforced.js activate \\
    --activated-by <name> --approved-by <name> \\
    --evidence-reference <id> --evidence-digest <sha256>
  AUTHORITY_ACTIVATION_DATABASE_URL=... node scripts/p5d-authority-activate-enforced.js status`);
    process.exit(2);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
    }
    return out;
}

async function connect(url) {
    return new PrismaClient({ datasources: { db: { url } } });
}

/** The operator credential must be the narrow authority, not a superuser. */
async function assertOperatorCredential(db) {
    const [row] = await db.$queryRawUnsafe(`
        SELECT current_user AS role,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
               has_table_privilege(current_user, '${enforcement.QUALIFIED_TABLE}', 'SELECT') AS can_select,
               has_table_privilege(current_user, '${enforcement.QUALIFIED_TABLE}', 'INSERT') AS can_insert,
               has_table_privilege(current_user, '${enforcement.QUALIFIED_TABLE}', 'UPDATE') AS can_update,
               has_table_privilege(current_user, '${enforcement.QUALIFIED_TABLE}', 'DELETE') AS can_delete,
               has_table_privilege(current_user, '${enforcement.QUALIFIED_TABLE}', 'TRUNCATE') AS can_truncate
    `);
    const refusals = [];
    if (row.is_superuser === true) refusals.push('the activation connection is a superuser');
    if (!row.can_select) refusals.push('the activation role cannot read the activation record');
    if (!row.can_insert) refusals.push('the activation role cannot insert the activation record');
    if (row.can_update) refusals.push('the activation role can UPDATE an existing activation record');
    if (row.can_delete) refusals.push('the activation role can DELETE an existing activation record');
    if (row.can_truncate) refusals.push('the activation role can TRUNCATE the activation record');
    return { role: row.role, refusals };
}

/** Prove the record is append-only from the operator's own connection. */
async function proveImmutability(db) {
    const proofs = { update: 'NOT_ATTEMPTED', delete: 'NOT_ATTEMPTED' };
    for (const op of ['update', 'delete']) {
        try {
            await db.$transaction(async (tx) => {
                if (op === 'update') {
                    await tx.$executeRawUnsafe(`UPDATE ${enforcement.QUALIFIED_TABLE} SET "approvedBy" = "approvedBy" WHERE "id" = 1`);
                } else {
                    await tx.$executeRawUnsafe(`DELETE FROM ${enforcement.QUALIFIED_TABLE} WHERE "id" = 1`);
                }
                // Reaching here means the boundary did NOT hold.
                proofs[op] = 'SUCCEEDED';
                throw new Error('__rollback__');
            });
        } catch (err) {
            if (err && err.message === '__rollback__') continue;
            proofs[op] = 'REFUSED';
        }
    }
    return proofs;
}

async function activate(db, args) {
    const activatedBy = args['activated-by'];
    const approvedBy = args['approved-by'];
    const evidenceReference = args['evidence-reference'];
    const evidenceDigest = args['evidence-digest'];

    if (!activatedBy || !ACTOR_RE.test(activatedBy)) usage('--activated-by must be a real operator identity');
    if (!approvedBy || !ACTOR_RE.test(approvedBy)) usage('--approved-by must name the approver of this decision');
    if (!evidenceReference || String(evidenceReference).trim().length < 8) {
        usage('--evidence-reference must identify the externally verified evidence (>= 8 chars)');
    }
    if (!evidenceDigest || !DIGEST_RE.test(String(evidenceDigest))) usage('--evidence-digest must be a sha256 hex digest');

    const credential = await assertOperatorCredential(db);
    if (credential.refusals.length > 0) {
        console.error(JSON.stringify({ ok: false, refused: 'OPERATOR_CREDENTIAL_NOT_NARROW', refusals: credential.refusals }, null, 2));
        process.exitCode = 1;
        return;
    }

    const existing = await enforcement.readActivationRecord(db);
    if (existing) {
        console.error(JSON.stringify({ ok: false, refused: 'ALREADY_ACTIVATED', activatedAt: existing.activatedAt }, null, 2));
        process.exitCode = 1;
        return;
    }

    // One permitted action: INSERT the singleton. The PRIMARY KEY plus the
    // CHECK (id = 1) make a second activation impossible, not merely refused by
    // this script.
    await db.$executeRawUnsafe(
        `INSERT INTO ${enforcement.QUALIFIED_TABLE}
           ("id", "activatedBy", "approvedBy", "evidenceReference", "evidenceDigest")
         VALUES (1, $1, $2, $3, $4)`,
        String(activatedBy), String(approvedBy), String(evidenceReference), String(evidenceDigest)
    );

    const proofs = await proveImmutability(db);
    const record = await enforcement.readActivationRecord(db);
    const gate = await enforcement.readEnforcedAuthority(db);

    console.log(JSON.stringify({
        ok: true,
        activatedBy: record.activatedBy,
        approvedBy: record.approvedBy,
        activatedAt: record.activatedAt,
        evidenceReference: record.evidenceReference,
        immutabilityProofs: proofs,
        gate: {
            enforcedActive: gate.enforcedActive,
            enforcementEstablished: gate.enforcementEstablished,
            reason: gate.reason,
            // The operator connection is not the runtime role, so the runtime
            // self-check cannot be satisfied from here; the application reports
            // its own verdict and this is informational only.
        },
    }, null, 2));

    if (proofs.update !== 'REFUSED' || proofs.delete !== 'REFUSED') {
        console.error('[WP-E] CRITICAL: the activation record is mutable by the activation role');
        process.exitCode = 1;
    }
}

async function status(db) {
    const gate = await enforcement.readEnforcedAuthority(db);
    console.log(JSON.stringify({
        enforcedActive: gate.enforcedActive,
        enforcementEstablished: gate.enforcementEstablished,
        reason: gate.reason,
        problems: gate.problems,
        activation: gate.activation,
    }, null, 2));
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const url = process.env.AUTHORITY_ACTIVATION_DATABASE_URL;
    if (!command) usage();
    if (!url) usage('AUTHORITY_ACTIVATION_DATABASE_URL is not set — activation must use the operator role, '
        + 'never the application runtime credential.');

    const db = await connect(url);
    try {
        if (command === 'activate') await activate(db, parseArgs(rest));
        else if (command === 'status') await status(db);
        else usage(`unknown command: ${command}`);
    } finally {
        await db.$disconnect();
    }
}

main().catch((err) => {
    console.error(`[WP-E] FAILED: ${err.message}`);
    process.exitCode = 3;
});
