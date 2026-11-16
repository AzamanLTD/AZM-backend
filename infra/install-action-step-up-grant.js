// infra/install-action-step-up-grant.js
// =============================================================================
// §WP-H G packaging overlay — the release-path home for the step-up grant table.
//
// The release path (`npm run release`, the Render preDeployCommand) runs overlay
// installers and NEVER `prisma migrate deploy`. Shipping the grant table as a
// migration alone left it uncreated in every deployed environment, which would
// make grant issuance throw the moment STEP_UP_ENFORCEMENT is ever turned on.
//
// The statements below are byte-for-byte the DDL in
// prisma/migrations/20261115120000_action_step_up_grant/migration.sql.
// __tests__/step-up-grant-installer-wiring.test.js fails if the two drift.
//
// Properties:
//   IDEMPOTENT   CREATE ... IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
//                EXISTS. Re-running changes nothing and NEVER deletes a live
//                grant, so a restart cannot re-open a consumed capability.
//   FAIL-CLOSED  any statement error, or a post-install shape that does not match
//                the Prisma model, sets a non-zero exit so the release stops.
//   NO SECRETS   only the SHA-256 hash of a token is ever stored.
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "ActionStepUpGrant" (
    "id"             TEXT PRIMARY KEY,
    "tokenHash"      TEXT NOT NULL UNIQUE,
    "userId"         TEXT NOT NULL,
    "actionType"     TEXT NOT NULL,
    "actionDigest"   TEXT NOT NULL,
    "routeScope"     TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "issuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "consumedAt"     TIMESTAMP(3)
);`,
  `CREATE INDEX IF NOT EXISTS "ActionStepUpGrant_userId_idx" ON "ActionStepUpGrant"("userId");`,
  `CREATE INDEX IF NOT EXISTS "ActionStepUpGrant_expiresAt_idx" ON "ActionStepUpGrant"("expiresAt");`,
  `CREATE OR REPLACE FUNCTION azm_step_up_grant_guard() RETURNS trigger AS $$
BEGIN
    IF OLD."consumedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'ActionStepUpGrant is single-use: % was already consumed', OLD."id";
    END IF;
    IF NEW."tokenHash" <> OLD."tokenHash"
       OR NEW."userId" <> OLD."userId"
       OR NEW."actionDigest" <> OLD."actionDigest"
       OR NEW."actionType" <> OLD."actionType"
       OR NEW."routeScope" <> OLD."routeScope" THEN
        RAISE EXCEPTION 'ActionStepUpGrant binding is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;`,
  `DROP TRIGGER IF EXISTS "ActionStepUpGrant_no_reuse" ON "ActionStepUpGrant";`,
  `CREATE TRIGGER "ActionStepUpGrant_no_reuse"
    BEFORE UPDATE ON "ActionStepUpGrant"
    FOR EACH ROW EXECUTE FUNCTION azm_step_up_grant_guard();`,
];

// The shape the Prisma model requires, asserted AFTER install so a half-applied
// or hand-edited database cannot silently pass as installed.
const EXPECTED_COLUMNS = [
  { name: 'id', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'tokenHash', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'userId', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'actionType', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'actionDigest', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'routeScope', dataType: 'text', nullable: 'NO', hasDefault: false },
  { name: 'idempotencyKey', dataType: 'text', nullable: 'YES', hasDefault: false },
  { name: 'issuedAt', dataType: 'timestamp without time zone', nullable: 'NO', hasDefault: true },
  { name: 'expiresAt', dataType: 'timestamp without time zone', nullable: 'NO', hasDefault: false },
  { name: 'consumedAt', dataType: 'timestamp without time zone', nullable: 'YES', hasDefault: false },
];

async function verify() {
  const problems = [];

  const columns = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ActionStepUpGrant'
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
      WHERE schemaname = 'public' AND tablename = 'ActionStepUpGrant'`
  );
  const byName = new Map((indexes || []).map((r) => [r.indexname, r.indexdef]));
  const canonical = (def) => String(def).replace(/"/g, '').replace(/\s+/g, ' ').trim();

  if (!byName.has('ActionStepUpGrant_pkey')) problems.push('primary key ActionStepUpGrant_pkey is missing');
  const tokenDef = byName.get('ActionStepUpGrant_tokenHash_key');
  if (!tokenDef) problems.push('unique index ActionStepUpGrant_tokenHash_key is missing');
  else if (!/CREATE UNIQUE INDEX/i.test(tokenDef) || !/\(tokenHash\)/.test(canonical(tokenDef))) {
    problems.push(`token index is not unique on (tokenHash): ${tokenDef}`);
  }
  const userDef = byName.get('ActionStepUpGrant_userId_idx');
  if (!userDef) problems.push('index ActionStepUpGrant_userId_idx is missing');
  const expDef = byName.get('ActionStepUpGrant_expiresAt_idx');
  if (!expDef) problems.push('index ActionStepUpGrant_expiresAt_idx is missing');

  const triggers = await prisma.$queryRawUnsafe(
    `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'ActionStepUpGrant' AND NOT t.tgisinternal`
  );
  const names = (triggers || []).map((r) => r.tgname);
  if (!names.includes('ActionStepUpGrant_no_reuse')) {
    problems.push('single-use guard trigger ActionStepUpGrant_no_reuse is missing');
  }

  return problems;
}

async function main() {
  for (const statement of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err) {
      logger.error({ err, statement: statement.slice(0, 80) },
        '[action-step-up-grant] statement failed');
      process.exitCode = 1;
      return;
    }
  }

  const problems = await verify();
  if (problems.length > 0) {
    logger.error({ problems }, '[action-step-up-grant] installed shape does not match the model');
    process.exitCode = 1;
    return;
  }
  logger.info('[action-step-up-grant] grant table verified');
}

main()
  .catch((err) => {
    logger.error({ err }, '[action-step-up-grant] install failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
