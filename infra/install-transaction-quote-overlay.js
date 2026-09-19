#!/usr/bin/env node
// Idempotent additive installer for the server-authoritative transaction quote table.
// Production is db-push managed, so this table is installed after Prisma schema
// convergence rather than being treated as an unmanaged object that db push may remove.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "TransactionQuote" (
    "id" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "amountGhs" DECIMAL(20,8) NOT NULL,
    "feeGhs" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "netGhs" DECIMAL(20,8) NOT NULL,
    "rateGhsPerUsdc" DECIMAL(20,8) NOT NULL,
    "usdcAmount" DECIMAL(30,12) NOT NULL,
    "rateSource" TEXT NOT NULL,
    "rateAsOf" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedFor" TEXT,
    CONSTRAINT "TransactionQuote_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE INDEX IF NOT EXISTS "TransactionQuote_userId_createdAt_idx"
    ON "TransactionQuote"("userId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "TransactionQuote_expiresAt_idx"
    ON "TransactionQuote"("expiresAt");`,
  `CREATE INDEX IF NOT EXISTS "TransactionQuote_userId_purpose_consumedAt_idx"
    ON "TransactionQuote"("userId", "purpose", "consumedAt");`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'TransactionQuote_userId_fkey'
    ) THEN
      ALTER TABLE "TransactionQuote"
        ADD CONSTRAINT "TransactionQuote_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$;`,
];

async function installTransactionQuoteOverlay(client) {
  const db = client || prisma;
  const results = { ok: 0, failed: 0, errors: [] };

  for (const sql of STATEMENTS) {
    try {
      await db.$executeRawUnsafe(sql);
      results.ok += 1;
    } catch (err) {
      results.failed += 1;
      const head = sql.split('\n')[0].slice(0, 100);
      results.errors.push(`${head} … → ${err.message.split('\n')[0]}`);
      logger.error(`[install-transaction-quote-overlay] ${head}: ${err.message}`);
    }
  }

  return results;
}

module.exports = { installTransactionQuoteOverlay };

if (require.main === module) {
  installTransactionQuoteOverlay()
    .then((result) => {
      logger.info(`[install-transaction-quote-overlay] ${result.ok} ok, ${result.failed} failed`);
      if (result.failed) process.exitCode = 1;
    })
    .catch((err) => {
      logger.error({ err }, '[install-transaction-quote-overlay] fatal');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
