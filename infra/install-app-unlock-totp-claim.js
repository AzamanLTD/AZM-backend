// infra/install-app-unlock-totp-claim.js
// =============================================================================
// WP-D packaging overlay — durable app-unlock TOTP replay authority.
//
// The app-unlock TOTP claim table is the SINGLE-USE authority: a unique
// (userId, step) index makes "exactly one winner" the database's decision
// instead of a read-then-write race in application code, and the row survives a
// process, container or cache restart. Without the table the service fails
// closed (503 APP_UNLOCK_STATE_UNAVAILABLE), i.e. app-unlock TOTP stops working.
//
// The release path (`npm run release`, the Render preDeployCommand) runs overlay
// installers and NEVER `prisma migrate deploy`, so shipping this as a migration
// alone left the table uncreated in every deployed environment. This installer
// is the release-path home for that DDL.
//
// The statements below are byte-for-byte the DDL in
// prisma/migrations/20261110200000_app_unlock_totp_claim/migration.sql.
// __tests__/app-unlock-claim-installer-wiring.test.js fails if the two drift.
//
// Properties:
//   IDEMPOTENT   every statement is CREATE ... IF NOT EXISTS; re-running is a
//                no-op and NEVER deletes a claim, so replay state is never
//                reset (a restart must not re-open an accepted code).
//   FAIL-CLOSED  any statement error, or a post-install shape that does not
//                match the model, sets a non-zero exit so the release stops.
//   NO SECRETS   only the time-step index is stored; never a code or secret.
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "AppUnlockTotpClaim" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppUnlockTotpClaim_pkey" PRIMARY KEY ("id")
);`,
  // The claim itself: one accepted code per user per 30s step, enforced by the
  // database rather than by a read-then-write check in application code.
  `CREATE UNIQUE INDEX IF NOT EXISTS "AppUnlockTotpClaim_userId_step_key"
    ON "AppUnlockTotpClaim"("userId", "step");`,
  // Supports the bounded cleanup of claims older than the replay window.
  `CREATE INDEX IF NOT EXISTS "AppUnlockTotpClaim_userId_createdAt_idx"
    ON "AppUnlockTotpClaim"("userId", "createdAt");`,
];

// The shape the Prisma model requires. Column order, type, nullability and the
// index set are asserted AFTER install so a half-applied or hand-edited database
// cannot silently pass as installed.
const EXPECTED_COLUMNS = [
  { name: 'id', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'userId', dataType: 'integer', nullable: 'NO', hasDefault: false },
  { name: 'step', dataType: 'integer', nullable: 'NO', hasDefault: false },
  { name: 'createdAt', dataType: 'timestamp without time zone', nullable: 'NO', hasDefault: true },
];

async function verify() {
  const problems = [];

  const columns = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AppUnlockTotpClaim'
      ORDER BY ordinal_position`
  );
  if (!Array.isArray(columns) || columns.length !== EXPECTED_COLUMNS.length) {
    problems.push(`expected ${EXPECTED_COLUMNS.length} columns, found ${columns ? columns.length : 0}`);
  } else {
    EXPECTED_COLUMNS.forEach((want, i) => {
      const got = columns[i];
      if (got.column_name !== want.name) problems.push(`column ${i + 1} is ${got.column_name}, expected ${want.name}`);
      if (got.data_type !== want.dataType) problems.push(`${want.name} type is ${got.data_type}, expected ${want.dataType}`);
      if (got.is_nullable !== want.nullable) problems.push(`${want.name} nullability is ${got.is_nullable}, expected ${want.nullable}`);
      if (Boolean(got.column_default) !== want.hasDefault) {
        problems.push(`${want.name} default presence is ${Boolean(got.column_default)}, expected ${want.hasDefault}`);
      }
    });
  }

  const indexes = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'AppUnlockTotpClaim'`
  );
  const byName = new Map((indexes || []).map((r) => [r.indexname, r.indexdef]));
  // pg_ indexes renders indexdef with its own quoting (("userId", step)), so
  // compare the normalised column list rather than the raw text.
  const canonical = (def) => String(def).replace(/"/g, '').replace(/\s+/g, ' ').trim();

  const uniqueDef = byName.get('AppUnlockTotpClaim_userId_step_key');
  if (!uniqueDef) problems.push('unique claim index AppUnlockTotpClaim_userId_step_key is missing');
  else if (!/CREATE UNIQUE INDEX/i.test(uniqueDef) || !/\(userId, step\)/.test(canonical(uniqueDef))) {
    problems.push(`claim index is not unique on (userId, step): ${uniqueDef}`);
  }
  const cleanupDef = byName.get('AppUnlockTotpClaim_userId_createdAt_idx');
  if (!cleanupDef) problems.push('cleanup index AppUnlockTotpClaim_userId_createdAt_idx is missing');
  else if (!/\(userId, createdAt\)/.test(canonical(cleanupDef))) {
    problems.push(`cleanup index is not on (userId, createdAt): ${cleanupDef}`);
  }
  if (!byName.has('AppUnlockTotpClaim_pkey')) problems.push('primary key AppUnlockTotpClaim_pkey is missing');

  return problems;
}

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err, statement: statement.slice(0, 80) },
        '[app-unlock-totp-claim] statement failed');
      process.exitCode = 1;
      return;
    }
  }

  const problems = await verify();
  if (problems.length > 0) {
    logger.error({ problems }, '[app-unlock-totp-claim] installed table does not match the model');
    process.exitCode = 1;
    return;
  }
  logger.info('[app-unlock-totp-claim] durable TOTP replay authority verified (idempotent).');
}

main()
  .catch((err) => {
    logger.error({ err }, '[app-unlock-totp-claim] fatal');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
