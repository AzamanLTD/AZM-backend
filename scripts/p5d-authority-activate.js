#!/usr/bin/env node
// scripts/p5d-authority-activate.js
// =============================================================================
// §P.5-D OPERATOR ENTRY POINT — the ONLY sanctioned way to change the regime.
//
//   node scripts/p5d-authority-activate.js preflight
//   node scripts/p5d-authority-activate.js activate --actor <adminId|name> --reason "<why>"
//   node scripts/p5d-authority-activate.js verify
//
// There is deliberately NO command that sets
// GlobalSettings.fiatLiquidityAuthorityEnabled directly:
//
//   • The Boolean alone is not the regime. Authority mode is the OR of the
//     Boolean and FiatLiquidityState.authorityActivatedAt, and the latch can
//     never be cleared. Flipping the Boolean by hand on a database whose GHS
//     projection is already written does NOT restore USDC semantics; it just
//     removes the audit trail.
//   • Activation refuses while any unresolved legacy fiat withdrawal without a
//     GHS reservation remains. `preflight` is read-only and shows every blocker
//     and advisory before you touch anything.
//
// Exit codes: 0 ok · 1 refused/blocked · 2 usage error · 3 runtime error.
// =============================================================================
'use strict';

const REQUIRED_SCHEMA = ['GlobalSettings', 'FiatLiquidityState', 'SystemFiatPool'];

function usage(message) {
    if (message) console.error(`\n${message}\n`);
    console.error(`Usage:
  node scripts/p5d-authority-activate.js preflight
  node scripts/p5d-authority-activate.js activate --actor <adminId|name> --reason "<why>"
  node scripts/p5d-authority-activate.js verify

preflight   read-only: every blocking and advisory row that would refuse activation
activate    explicit, audited activation (requires --actor and --reason)
verify      post-activation state: latch, GHS projection, audit entry`);
    process.exit(2);
}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const opts = {};
    for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i];
        if (!token.startsWith('--')) usage(`Unexpected argument: ${token}`);
        const key = token.slice(2);
        const value = rest[i + 1];
        if (value === undefined || value.startsWith('--')) usage(`--${key} needs a value`);
        opts[key] = value;
        i += 1;
    }
    return { command, opts };
}

function printPreflight(preflight) {
    console.log(`\nblocking rows : ${preflight.blockers.length}`);
    for (const b of preflight.blockers) {
        console.log(`  BLOCKER ${b.reason} — ${b.count} row(s)${b.ids && b.ids.length ? ` [${b.ids.slice(0, 10).join(', ')}]` : ''}`);
    }
    console.log(`advisory rows : ${preflight.advisories.length}`);
    for (const a of preflight.advisories) {
        console.log(`  ADVISORY ${a.reason} — ${a.count} row(s)${a.ids && a.ids.length ? ` [${a.ids.slice(0, 10).join(', ')}]` : ''}`);
    }
    console.log(`safe to activate: ${preflight.ok ? 'YES' : 'NO — resolve every blocker first'}\n`);
}

/**
 * The ONE definition of "the regime is correctly in place and consistent".
 *
 * `mode.active` is not enough: it is the OR of the Boolean and the latch, so a
 * hand-flipped Boolean on an unlatched database would pass. This requires the
 * LATCH, then proves the published projection agrees with the authoritative GHS
 * liquidity state, then proves the durable audit record says the same thing.
 */
async function verifyEvidence(prisma, activation, Prisma) {
    const failures = [];
    const mode = await activation.readModeAndPool(prisma);
    const state = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
    const audit = await prisma.adminSettingsAuditLog.findFirst({
        where: { action: 'P5D_AUTHORITY_ACTIVATED' },
        orderBy: { createdAt: 'desc' },
    });

    if (mode.latched !== true) failures.push('LATCH_ABSENT: FiatLiquidityState.authorityActivatedAt is null — the regime is not latched, so the GHS projection could be reinterpreted as USDC.');
    if (!mode.activatedAt) failures.push('LATCH_TIMESTAMP_MISSING');

    const availableGhs = state ? new Prisma.Decimal(state.availableGhs) : null;
    const projection = pool ? new Prisma.Decimal(pool.balance) : null;
    if (availableGhs === null) failures.push('AUTHORITATIVE_STATE_MISSING: FiatLiquidityState row absent.');
    if (projection === null) failures.push('PROJECTION_MISSING: SystemFiatPool row absent.');
    if (availableGhs !== null && projection !== null && !availableGhs.equals(projection)) {
        failures.push(`PROJECTION_MISMATCH: SystemFiatPool ${projection.toFixed(2)} != FiatLiquidityState.availableGhs ${availableGhs.toFixed(2)} (GHS).`);
    }

    if (!audit) {
        failures.push('AUDIT_MISSING: no P5D_AUTHORITY_ACTIVATED record.');
    } else {
        const changes = audit.changes || {};
        const auditLatch = changes.latch && changes.latch.new ? new Date(changes.latch.new) : null;
        if (!auditLatch) failures.push('AUDIT_LATCH_MISSING');
        if (auditLatch && mode.activatedAt && auditLatch.getTime() !== new Date(mode.activatedAt).getTime()) {
            failures.push('AUDIT_LATCH_MISMATCH: the recorded latch timestamp differs from the live latch.');
        }
        const auditedProjection = changes.projection ? changes.projection.projectedBalance : null;
        if (auditedProjection === null || auditedProjection === undefined) {
            failures.push('AUDIT_PROJECTION_MISSING');
        } else if (projection !== null && !new Prisma.Decimal(auditedProjection).equals(projection)) {
            failures.push(`AUDIT_PROJECTION_MISMATCH: audit says ${new Prisma.Decimal(auditedProjection).toFixed(2)}, pool holds ${projection.toFixed(2)}.`);
        }
        if (!changes.reason) failures.push('AUDIT_REASON_MISSING');
    }

    return {
        ok: failures.length === 0,
        failures,
        evidence: {
            active: mode.active,
            flagged: mode.flagged,
            latched: mode.latched,
            activatedAt: mode.activatedAt,
            currency: mode.currency,
            authoritativeAvailableGhs: availableGhs === null ? null : availableGhs.toFixed(2),
            systemFiatPoolProjection: projection === null ? null : projection.toFixed(2),
            auditEntryId: audit ? audit.id : null,
            auditRecordedAt: audit ? audit.createdAt : null,
        },
    };
}

async function main() {
    const { command, opts } = parseArgs(process.argv.slice(2));
    if (!['preflight', 'activate', 'verify'].includes(command)) usage(`Unknown command: ${command || '(none)'}`);

    const { PrismaClient, Prisma } = require('@prisma/client');
    const prisma = new PrismaClient();
    const activation = require('../src/services/fiatLiquidityActivationService');
    let exitCode = 0;

    try {
        const tables = await prisma.$queryRawUnsafe(
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
            REQUIRED_SCHEMA
        );
        if (tables.length !== REQUIRED_SCHEMA.length) {
            throw new Error(`This database is missing ${REQUIRED_SCHEMA.join(', ')}; apply the schema before running this script.`);
        }

        if (command === 'preflight') {
            const preflight = await activation.activationPreflight(prisma);
            printPreflight(preflight);
            exitCode = preflight.ok ? 0 : 1;
        } else if (command === 'verify') {
            const verdict = await verifyEvidence(prisma, activation, Prisma);
            console.log(JSON.stringify({ verified: verdict.ok, failures: verdict.failures, evidence: verdict.evidence }, null, 2));
            if (!verdict.ok) {
                console.error('Verification FAILED — the regime is not provably in place.');
                exitCode = 1;
            }
        } else {
            if (!opts.actor) usage("activate requires --actor (the operator's admin id or name).");
            if (!opts.reason || opts.reason.trim().length < 8) usage('activate requires --reason with a real explanation (at least 8 characters).');

            const preflight = await activation.activationPreflight(prisma);
            printPreflight(preflight);
            if (!preflight.ok) {
                console.error('Refusing to activate: resolve every BLOCKER above, then re-run preflight.');
                exitCode = 1;
            } else {
                const actor = /^\d+$/.test(opts.actor) ? Number(opts.actor) : opts.actor;
                const result = await activation.activateAuthority(prisma, { actor, reason: opts.reason });

                // Post-commit proof: the latch, the projection and the audit row
                // must all agree BEFORE this command reports success.
                const verdict = await verifyEvidence(prisma, activation, Prisma);
                console.log(JSON.stringify({
                    activated: result.active,
                    latchedAt: result.activatedAt,
                    currency: result.currency,
                    authoritativeBalance: String((result.projection && result.projection.balance) ?? result.balance ?? ''),
                    verified: verdict.ok,
                    failures: verdict.failures,
                    evidence: verdict.evidence,
                    next: 'Withdrawals now reserve GHS through the authority. The Boolean may be turned off without changing the regime, and the latch can never be cleared.',
                }, null, 2));
                if (!verdict.ok) {
                    console.error('ACTIVATION VERIFICATION FAILED — do not proceed; inspect the failures above.');
                    exitCode = 3;
                }
            }
        }
    } finally {
        await prisma.$disconnect();
    }
    return exitCode;
}

module.exports = { verifyEvidence, main };

if (require.main === module) {
    main()
        .then((code) => { process.exitCode = code; })
        .catch((err) => {
            console.error(`[p5d-authority-activate] ${err.code ? `[${err.code}] ` : ''}${err.message}`);
            if (err.preflight) printPreflight(err.preflight);
            process.exitCode = 3;
        });
}
