#!/usr/bin/env node
// WP-I trusted-wallet overlay: adds FiatProviderEvent.walletAccount.
//
// WHY THIS EXISTS: the observation identity is `moolre|collection|<ref>` and
// Moolre documents `externalref` as unique PER WALLET. Two wallets reusing one
// reference therefore collide into one claim identity, and the wallet that
// received the money is not stored at all. The column is the evidence that makes
// a wallet-scoped identity possible. This installer adds the evidence; it does
// NOT cut anything over to a wallet-scoped identity (see the hand-off doc §6:
// switching one path ahead of the others lets a single payment be claimed under
// both identities, so the cut-over is all-or-nothing and is not in this change).
//
// SINGLE SOURCE OF TRUTH: the DDL is not restated here. This applies
// prisma/sql/2026-11-18-fiat-provider-event-wallet-account.sql, the same file the
// real-PostgreSQL suite applies.
//
// FAIL CLOSED: on a database without FiatProviderEvent this exits non-zero with a
// clear message and writes nothing. It must never "succeed" by doing nothing,
// because the release chain would then report a provisioned column that does not
// exist.
//
// RELEASE CHAIN: segment 15 of the `&&` chain (step 14 in DEPLOY_RUNBOOK's
// guard-excluded command numbering), immediately after
// install-fiat-liquidity-overlay.js, which creates the table.
//
// NOTHING READS THIS COLUMN YET, and this comment must not pretend otherwise:
// install-provider-observation-claim.js selects walletAccount from
// ProviderSettlementWitness, a different column on a different table. The
// FiatProviderEvent column is evidence for the wallet-scoped identity described in
// the hand-off §6, which is a separate all-or-nothing cut-over. Its position ahead
// of that backfill is a forward guarantee (the slot a future wallet-scoped reader
// needs), not a present dependency.
//
// The column is deliberately NOT declared in prisma/schema.prisma yet. Declaring
// it makes Prisma select it on every FiatProviderEvent read, so any database
// without the column fails all of those reads. Measured: the p5d authority suite
// re-provisions this table through install-fiat-liquidity-overlay.js, which
// recreates it without this column, so with the field declared that suite failed
// with 500s and the column was gone afterwards; without the field the same path
// passes 63/63. The model field lands together with a wallet-scoped reader and
// with provisioning that creates the column everywhere, not before.
//
// Idempotent: re-running is a no-op. Mirrors install-business-currency-overlay.js.

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const SQL_FILE = path.join(__dirname, '..', 'prisma', 'sql', '2026-11-18-fiat-provider-event-wallet-account.sql');
const TABLE = 'FiatProviderEvent';

class WalletOverlayRefused extends Error {
    constructor(message) {
        super(message);
        this.name = 'WalletOverlayRefused';
        this.code = 'WP_I_WALLET_OVERLAY_REFUSED';
    }
}

// Strip comment lines BEFORE splitting: a comment may contain a semicolon and
// splitting first produces an unterminated statement.
function statementsFromFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    return raw
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Applies the overlay. Refuses before any write when the table is absent, and
 * applies every statement in ONE transaction so a failure cannot leave a column
 * without its index (or the reverse).
 */
async function installWalletOverlay(prisma, { sqlFile = SQL_FILE } = {}) {
    const [present] = await prisma.$queryRawUnsafe(
        // Cast to text: Prisma cannot deserialize a raw regclass column.
        `SELECT to_regclass('public."${TABLE}"')::text AS reg`,
    );
    if (!present || present.reg == null) {
        throw new WalletOverlayRefused(
            `${TABLE} does not exist. This overlay adds a column to it, so it cannot run before `
            + 'install-fiat-liquidity-overlay.js (release step 14). Nothing was written.',
        );
    }

    const statements = statementsFromFile(sqlFile);
    if (statements.length === 0) {
        throw new WalletOverlayRefused(`${path.basename(sqlFile)} contains no statements.`);
    }

    await prisma.$transaction(async (tx) => {
        for (const statement of statements) {
            await tx.$executeRawUnsafe(statement);
        }
    }, { timeout: 30000 });

    return { applied: statements.length, table: TABLE };
}

async function main() {
    const prisma = new PrismaClient();
    try {
        const result = await installWalletOverlay(prisma);
        logger.info({ ...result }, '[wp-i] FiatProviderEvent.walletAccount overlay applied (idempotent)');
    } catch (err) {
        logger.error({ err: err?.message, code: err?.code }, '[wp-i] wallet overlay refused');
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect().catch(() => {});
    }
}

if (require.main === module) main();

module.exports = { installWalletOverlay, statementsFromFile, WalletOverlayRefused, SQL_FILE, TABLE };
