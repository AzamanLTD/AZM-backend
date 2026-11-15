#!/usr/bin/env node
// Release installer for the native-GHS BusinessOrder columns.
//
// WHY THIS EXISTS: prisma/schema.prisma declares BusinessOrder.currency,
// BusinessOrder.amountGhs and a nullable amountUsdc, and
// src/lib/businessOrderCurrency.js enforces the pairing in the service layer.
// But service-layer enforcement is not the authority, and under this
// repository's release model the only production DDL path is the overlay
// installers run by `npm run release` — `prisma db push` is a dev/test path and
// creates no CHECK constraints. Without this installer production has no
// currency column at all and a GHS order has nowhere to put a cedi amount.
//
// SINGLE SOURCE OF TRUTH: the DDL itself is NOT restated here. This installer
// applies prisma/sql/2026-11-15-business-order-currency-contract.sql — the same
// file the real-PostgreSQL contract suite applies — so the release chain and the
// tests can never drift apart. Edit the .sql file, not this runner.
//
// LEGACY DATA: rows written before this overlay carry currency = NULL and a
// nominal amountUsdc. They stay valid under the contract's constraints and are
// never relabelled as native GHS. A row may not hold cedi values in the USDC
// column, and may not hold both amounts.
//
// Idempotent: every statement in the SQL file is guarded, so re-running is a
// no-op. Mirrors install-business-price-overlay.js (PrismaClient + raw
// statements, fail-closed exit code).

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const SQL_FILE = path.join(__dirname, '..', 'prisma', 'sql', '2026-11-15-business-order-currency-contract.sql');

// Strip comment lines BEFORE splitting: a comment may legitimately contain a
// semicolon, and splitting first produces "unterminated quoted string".
function statementsFromFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// Defensive widening, kept out of the shared .sql file so that file stays a pure
// statement of the contract. An earlier shape declared VARCHAR(3), which cannot
// hold "USDC" (4 chars). A no-op when the width already matches, and skipped
// entirely when the column does not exist yet (the .sql file creates it).
const WIDEN_CURRENCY = `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'BusinessOrder' AND column_name = 'currency'
      AND character_maximum_length = 3
  ) THEN
    ALTER TABLE "BusinessOrder" ALTER COLUMN "currency" TYPE VARCHAR(8);
  END IF;
END $$;`;

async function main() {
  for (const sql of statementsFromFile(SQL_FILE)) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.error(`[business-currency-overlay] statement failed: ${error.message}`);
      throw error;
    }
  }
  await prisma.$executeRawUnsafe(WIDEN_CURRENCY);
  logger.info('[business-currency-overlay] BusinessOrder currency + amountGhs + constraints installed (idempotent)');
}

main()
  .catch((error) => {
    logger.error(`[business-currency-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
