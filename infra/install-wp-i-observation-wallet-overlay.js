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
// NOT REGISTERED IN THE RELEASE CHAIN YET. The hand-off requests position 15
// (immediately after install-fiat-liquidity-overlay.js, which creates the table,
// and before install-provider-observation-claim.js, which will read the column).
// Registration is deliberately a separate change: it edits the release path, and
// the schema change must first be coordinated with the shared Prisma model.
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
