#!/usr/bin/env node
// Idempotent additive installer for Notification soft-dismissal
// (marketplace personalisation, Backend E): the isDismissed BOOLEAN NOT
// NULL DEFAULT false column, the dismissedAt TIMESTAMPTZ(3) NULL column,
// and the (userId, isDismissed) index. Same provisioning contract as the
// other overlays (release chain + boot autoRelease + CI); the DDL below
// is the exact shape `prisma db push` renders.
//
// Idempotent: safe to re-run on every deploy/start. FAIL-CLOSED on drift.

const { PrismaClient } = require('@prisma/client');

const ADD_DISMISSED_SQL = `
  ALTER TABLE "Notification"
    ADD COLUMN IF NOT EXISTS "isDismissed" BOOLEAN`;
const ADD_DISMISSED_AT_SQL = `
  ALTER TABLE "Notification"
    ADD COLUMN IF NOT EXISTS "dismissedAt" TIMESTAMP(3)`;
const BACKFILL_SQL = `
  UPDATE "Notification" SET "isDismissed" = false
   WHERE "isDismissed" IS NULL`;
const SET_DEFAULT_SQL = `
  ALTER TABLE "Notification"
    ALTER COLUMN "isDismissed" SET DEFAULT false`;
const SET_NOT_NULL_SQL = `
  ALTER TABLE "Notification" ALTER COLUMN "isDismissed" SET NOT NULL`;
const ADD_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS "Notification_userId_isDismissed_idx"
      ON "Notification" ("userId", "isDismissed")`;

const VALIDATE_SQL = `
  SELECT a.attnotnull AS not_null, t.typname AS type_name, c.column_default
  FROM pg_catalog.pg_class cl
  JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN information_schema.columns c
       ON c.table_schema = n.nspname AND c.table_name = cl.relname AND c.column_name = a.attname
  WHERE n.nspname = current_schema() AND cl.relname = 'Notification' AND a.attname IN ('isDismissed','dismissedAt')`;

const INDEX_SQL = `
  SELECT COUNT(*) AS n FROM pg_indexes
  WHERE schemaname = current_schema() AND tablename = 'Notification'
    AND indexname = 'Notification_userId_isDismissed_idx'`;

async function installNotificationDismissalOverlay(prisma) {
    await prisma.$executeRawUnsafe(ADD_DISMISSED_SQL);
    await prisma.$executeRawUnsafe(ADD_DISMISSED_AT_SQL);
    await prisma.$executeRawUnsafe(BACKFILL_SQL);
    await prisma.$executeRawUnsafe(SET_DEFAULT_SQL);
    await prisma.$executeRawUnsafe(SET_NOT_NULL_SQL);
    await prisma.$executeRawUnsafe(ADD_INDEX_SQL);

    const rows = await prisma.$queryRawUnsafe(VALIDATE_SQL);
    const byName = {};
    for (const r of rows) byName[r.type_name] = r;
    const problems = [];
    if (!byName.bool) problems.push('isDismissed column missing or wrong type');
    else if (!byName.bool.not_null) problems.push('isDismissed is nullable');
    else if (!(byName.bool.column_default || '').includes('false')) {
        problems.push('isDismissed default is ' + byName.bool.column_default + ', expected false');
    }
    if (!byName.timestamp) problems.push('dismissedAt column missing or wrong type');
    else if (byName.timestamp.not_null) problems.push('dismissedAt must be nullable');
    const idx = (await prisma.$queryRawUnsafe(INDEX_SQL))[0] || {};
    if (Number(idx.n) < 1) problems.push('missing (userId, isDismissed) index');
    if (problems.length) {
        throw new Error('Notification dismissal drift: ' + problems.join('; '));
    }
    return { ok: 1, failed: 0 };
}

async function main() {
    const prisma = new PrismaClient();
    try {
        await installNotificationDismissalOverlay(prisma);
        // eslint-disable-next-line no-console
        console.log('[install-notification-dismissal-overlay] ok');
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[install-notification-dismissal-overlay] FAILED:', err.message);
    process.exit(1);
});

module.exports = { installNotificationDismissalOverlay };
