// infra/install-r42-idempotency-overlay.js
// =============================================================================
// §r42 — shared financial idempotency authority overlay.
//
// Creates the FinancialOperation claim table (the durable economic operation
// identity behind the Idempotency-Key header) and drops the retired
// IdempotencyKey response-cache table. The old table was a pure derived
// convenience cache (24h TTL) — no economic identity lives in it, so dropping
// it loses nothing that can affect money. Idempotent: safe to re-run.
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "FinancialOperation" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"        INTEGER NOT NULL,
    "endpoint"      TEXT NOT NULL,
    "key"           TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "fingerprint"   TEXT NOT NULL,
    "failurePolicy" TEXT NOT NULL DEFAULT 'RETAIN',
    "statusCode"    INTEGER,
    "responseBody"  TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinancialOperation_pkey" PRIMARY KEY ("id")
  );`,
  // §r42 byte-fidelity: converge any existing install that created the
  // column as JSONB (key-reordering storage) to TEXT (wire-text storage).
  `ALTER TABLE "FinancialOperation" ALTER COLUMN "responseBody" TYPE TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FinancialOperation_userId_endpoint_key_key"
    ON "FinancialOperation"("userId", "endpoint", "key");`,
  `CREATE INDEX IF NOT EXISTS "FinancialOperation_createdAt_idx"
    ON "FinancialOperation"("createdAt");`,
  // Retire the r41-era response cache. Global key scope + 24h expiry made it
  // unsafe as an economic identity; its rows carry no money truth.
  `DROP TABLE IF EXISTS "IdempotencyKey";`,
];

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err, statement: statement.slice(0, 80) },
        '[r42-idempotency] statement failed');
      process.exitCode = 1;
      return;
    }
  }
  logger.info('[r42-idempotency] financial operation authority overlay verified (idempotent).');
}

main()
  .catch((err) => {
    logger.error({ err }, '[r42-idempotency] fatal');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
