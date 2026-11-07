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

async function main() {
    const { command, opts } = parseArgs(process.argv.slice(2));
    if (!['preflight', 'activate', 'verify'].includes(command)) usage(`Unknown command: ${command || '(none)'}`);

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const activation = require('../src/services/fiatLiquidityActivationService');

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
        process.exit(preflight.ok ? 0 : 1);
    }

    if (command === 'verify') {
        const mode = await activation.readModeAndPool(prisma);
        const audit = await prisma.adminSettingsAuditLog.findFirst({
            where: { action: 'P5D_AUTHORITY_ACTIVATED' },
            orderBy: { createdAt: 'desc' },
        });
        console.log(JSON.stringify({
            active: mode.active,
            flagged: mode.flagged,
            latched: mode.latched,
            activatedAt: mode.activatedAt,
            currency: mode.currency,
            balance: String(mode.balance),
            authoritativeSource: mode.source,
            latestAuditEntry: audit ? { id: audit.id, adminId: audit.adminId, adminName: audit.adminName, createdAt: audit.createdAt, changes: audit.changes } : null,
        }, null, 2));
        process.exit(mode.active && audit ? 0 : 1);
    }

    // activate
    if (!opts.actor) usage("activate requires --actor (the operator's admin id or name).");
    if (!opts.reason || opts.reason.trim().length < 8) usage('activate requires --reason with a real explanation (at least 8 characters).');

    const preflight = await activation.activationPreflight(prisma);
    printPreflight(preflight);
    if (!preflight.ok) {
        console.error('Refusing to activate: resolve every BLOCKER above, then re-run preflight.');
        process.exit(1);
    }

    const actor = /^\d+$/.test(opts.actor) ? Number(opts.actor) : opts.actor;
    const result = await activation.activateAuthority(prisma, { actor, reason: opts.reason });
    const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
    const audit = await prisma.adminSettingsAuditLog.findFirst({
        where: { action: 'P5D_AUTHORITY_ACTIVATED' },
        orderBy: { createdAt: 'desc' },
    });
    console.log(JSON.stringify({
        activated: result.active,
        latchedAt: result.activatedAt,
        currency: result.currency,
        authoritativeBalance: String(result.balance ?? ''),
        systemFiatPoolProjection: pool ? String(pool.balance) : null,
        auditEntryId: audit ? audit.id : null,
        next: 'Withdrawals now reserve GHS through the authority. The Boolean may be turned off without changing the regime, and the latch can never be cleared.',
    }, null, 2));
}

main().catch((err) => {
    console.error(`[p5d-authority-activate] ${err.code ? `[${err.code}] ` : ''}${err.message}`);
    if (err.preflight) printPreflight(err.preflight);
    process.exit(3);
});
