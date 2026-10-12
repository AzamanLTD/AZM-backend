// infra/install-r42-idempotency-overlay.js
// =============================================================================
// §r42 — shared financial idempotency authority overlay.
//
// Creates the FinancialOperation claim table (the durable economic operation
// identity behind the Idempotency-Key header) and retires the IdempotencyKey
// response-cache table. The old table was a pure derived convenience cache
// (24h TTL) — no economic identity lives in it. Idempotent: safe to re-run.
//
// Fail-closed retirement: the legacy table is dropped ONLY when absent or
// empty. The check-and-drop is a single atomic DO block that first takes an
// ACCESS EXCLUSIVE lock on the legacy table, so concurrent writers cannot
// populate it between the check and the drop (the workflow preflight runs in
// a separate job earlier — rows may legally appear in between). A populated
// table aborts the installer (exit 1) with every legacy row intact.
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
  // unsafe as an economic identity; its rows carry no money truth — but rows
  // the operator has not exported are never ours to destroy.
  //
  // Atomic TOCTOU-safe retirement: one statement = one transaction. The
  // ACCESS EXCLUSIVE lock waits out any in-flight INSERT (its writer
  // transaction holds ROW EXCLUSIVE) and blocks new writers until this
  // transaction ends, so the row count and the DROP observe exactly the
  // same committed state. If a writer committed even a single row before
  // the lock landed, the count sees it and the block aborts with the table
  // fully intact — the never-drop-a-populated-table invariant holds even
  // for rows inserted after the caller's preflight.
  `DO $$
  DECLARE
    legacy_rows INTEGER;
  BEGIN
    IF to_regclass('public."IdempotencyKey"') IS NOT NULL THEN
      LOCK TABLE public."IdempotencyKey" IN ACCESS EXCLUSIVE MODE;
      SELECT count(*) INTO legacy_rows FROM public."IdempotencyKey";
      IF legacy_rows > 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = format(
            'IdempotencyKey is populated (%s rows); refusing to drop it — legacy rows would be destroyed. Export/migrate the rows, empty the table, and re-run.',
            legacy_rows);
      END IF;
      DROP TABLE public."IdempotencyKey";
    END IF;
  END $$;`,
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
