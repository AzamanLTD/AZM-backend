#!/usr/bin/env node
// Idempotent additive installer for the r19 smart-route execution snapshot
// (audit P0, 2026-09-21). Mirrored by
// prisma/migrations/20260921150000_r19_smartroute_execution_snapshot/migration.sql.
//
// Production is db-push managed, so the snapshot columns and index are
// installed idempotently here at release time. Running this installer
// repeatedly is safe: every statement is IF NOT EXISTS.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

const STATEMENTS = [
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "action" "SmartRouteAction";`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destMomoNumber" TEXT;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destMomoProvider" TEXT;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destFriendUserId" INTEGER;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destSavingsGoalId" TEXT;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "destVaultId" TEXT;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "frequency" "SmartRouteFrequency";`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "dayOfMonth" INTEGER;`,
  `ALTER TABLE "SmartRouteRun" ADD COLUMN IF NOT EXISTS "claimedOccurrenceAt" TIMESTAMP(3);`,
  `CREATE INDEX IF NOT EXISTS "SmartRouteRun_status_routeId_idx"
    ON "SmartRouteRun"("status", "routeId");`,
];

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err, statement: statement.slice(0, 80) },
        '[r19-smartroute-execution-snapshot] statement failed');
      process.exitCode = 1;
      return;
    }
  }
  logger.info('[r19-smartroute-execution-snapshot] smart-route execution snapshot overlay verified (idempotent).');
}

main()
  .catch((err) => {
    logger.error({ err }, '[r19-smartroute-execution-snapshot] fatal');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
