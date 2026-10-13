#!/usr/bin/env node
// Idempotent additive installer for the r16 smart-route execution identity
// (audit P0-A, 2026-09-20). Mirrored by
// prisma/migrations/20260920170000_r16_smartroute_execution_identity/migration.sql
// and prisma/migrations/20260920210000_r16c_smartroute_awaiting_reconciliation/migration.sql:
// production enum values are installed ONLY through this overlay (db push
// owns greenfield; the release chain owns convergence), so the r16c lease
// and reconciliation values must be added here too — a production branch
// whose enum predates r16c otherwise rejects every lease/reconciliation
// query with 22P02 (observed on the original production branch 2026-10-13).
//
// Production is db-push managed, so the enum value, the unique columns and
// their indexes are installed idempotently here at release time. Running
// this installer repeatedly is safe: every statement is IF NOT EXISTS or
// duplicate-guarded.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `DO $$ BEGIN
    ALTER TYPE "SmartRouteRunStatus" ADD VALUE IF NOT EXISTS 'PENDING';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END $$;`,
  `DO $$ BEGIN
    ALTER TYPE "SmartRouteRunStatus" ADD VALUE IF NOT EXISTS 'EXECUTING';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END $$;`,
  `DO $$ BEGIN
    ALTER TYPE "SmartRouteRunStatus" ADD VALUE IF NOT EXISTS 'AWAITING_RECONCILIATION';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END $$;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "executionKey" TEXT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SmartRouteRun_executionKey_key"
    ON "SmartRouteRun"("executionKey");`,
  `ALTER TABLE "VaultDeposit" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "VaultDeposit_idempotencyKey_key"
    ON "VaultDeposit"("idempotencyKey");`,
];

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err, statement: statement.slice(0, 80) },
        '[r16-execution-identity] statement failed');
      process.exitCode = 1;
      return;
    }
  }
  logger.info('[r16-execution-identity] smart-route execution identity overlay verified (idempotent).');
}

main()
  .catch((err) => {
    logger.error({ err }, '[r16-execution-identity] fatal');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
