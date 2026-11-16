#!/usr/bin/env node
// Release installer for the dine-in / business-ledger currency contract.
//
// WHY THIS EXISTS: prisma/schema.prisma now declares DineInTab.currency and the
// *Ghs carriers, DineInTabItem's cedi line money, and BusinessLedgerEntry.currency
// with a nullable amount. But production DDL under this repository's release model
// comes from the overlay installers run by `npm run release` — `prisma db push`
// creates columns and creates NO CHECK constraints — and the invariant that
// matters ("a cedi sale is never stored as USDC income") is a constraint, not a
// column.
//
// SINGLE SOURCE OF TRUTH: the DDL is NOT restated here. This installer applies
// prisma/sql/2026-11-16-dine-in-currency-contract.sql, the same file the
// real-PostgreSQL contract suite applies, so release and tests cannot drift.
//
// Idempotent: every statement is guarded, so re-running is a no-op. Mirrors
// install-business-currency-overlay.js (PrismaClient + raw statements, fail-closed
// exit code).
//
// NOTE ON EXISTING ROWS: this contract is satisfied by every legacy row, because a
// legacy tab/invoice/ledger row has currency NULL and no *Ghs values, which the
// shape checks allow by construction. No backfill is performed and no historical
// amount is relabelled.

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const SQL_FILE = path.join(__dirname, '..', 'prisma', 'sql', '2026-11-16-dine-in-currency-contract.sql');

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

async function main() {
  for (const sql of statementsFromFile(SQL_FILE)) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.error(`[dine-in-currency-overlay] statement failed: ${error.message}`);
      throw error;
    }
  }
  logger.info('[dine-in-currency-overlay] DineInTab / DineInTabItem / BusinessLedgerEntry currency contract installed (idempotent)');
}

main()
  .catch((error) => {
    logger.error(`[dine-in-currency-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
