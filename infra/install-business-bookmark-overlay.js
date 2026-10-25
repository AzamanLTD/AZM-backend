#!/usr/bin/env node
// Idempotent additive installer for the BusinessBookmark table
// (marketplace personalisation, Backend A — user-scoped saved businesses).
//
// PROVISIONING CONTRACT (DEPLOY_RUNBOOK.md): production DDL is deployed
// EXCLUSIVELY by these overlay installers via `npm run release` AND via
// the boot-time autoRelease.js chain (Render Free plan does not run the
// pre-deploy command, so boot-time provisioning is the real production
// path there). The table is therefore created HERE with the exact shape
// `prisma db push` renders from prisma/schema.prisma, so the db-push path
// (disposable dev/test + CI) and the release-chain/boot-time paths
// (production) converge on the identical structure.
//
// Idempotent: safe to re-run on every deploy/start. FAIL-CLOSED on drift:
// a wrong column type, missing constraint, missing cascade rule or
// missing index aborts with a clear error instead of silently leaving a
// mismatched table.

const { PrismaClient } = require('@prisma/client');

// Matches the db-push render of the BusinessBookmark model exactly:
// uuid-pk text column (application-side uuid), NOT NULL FK columns with
// ON DELETE CASCADE on both sides, the unique (businessProfileId,
// customerId) pair that makes repeated save/unsave idempotent, and the two
// lookup indexes (customer list scans, business cascade deletes).
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "BusinessBookmark" (
      "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      "businessProfileId" TEXT NOT NULL,
      "customerId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "BusinessBookmark_pkey" PRIMARY KEY ("id")
  )`;

const ADD_FK_BUSINESS_SQL = `
  DO $$ BEGIN
      IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'BusinessBookmark_businessProfileId_fkey'
      ) THEN
          ALTER TABLE "BusinessBookmark"
              ADD CONSTRAINT "BusinessBookmark_businessProfileId_fkey"
              FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
  END $$`;

const ADD_FK_CUSTOMER_SQL = `
  DO $$ BEGIN
      IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'BusinessBookmark_customerId_fkey'
      ) THEN
          ALTER TABLE "BusinessBookmark"
              ADD CONSTRAINT "BusinessBookmark_customerId_fkey"
              FOREIGN KEY ("customerId") REFERENCES "User"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
  END $$`;

const ADD_UNIQUE_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS "BusinessBookmark_businessProfileId_customerId_key"
      ON "BusinessBookmark" ("businessProfileId", "customerId")`;

const ADD_IDX_BUSINESS_SQL = `
  CREATE INDEX IF NOT EXISTS "BusinessBookmark_businessProfileId_idx"
      ON "BusinessBookmark" ("businessProfileId")`;

const ADD_IDX_CUSTOMER_SQL = `
  CREATE INDEX IF NOT EXISTS "BusinessBookmark_customerId_idx"
      ON "BusinessBookmark" ("customerId")`;

// Schema-qualified pg_catalog proof of the intended shape.
const VALIDATE_SQL = `
  SELECT
      cl.relname                 AS table_name,
      a.attname                  AS column_name,
      a.attnotnull               AS not_null,
      t.typname                  AS type_name,
      c.column_default           AS column_default
  FROM pg_catalog.pg_class cl
  JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN information_schema.columns c
       ON c.table_schema = n.nspname AND c.table_name = cl.relname AND c.column_name = a.attname
  WHERE n.nspname = current_schema() AND cl.relname = 'BusinessBookmark'
  ORDER BY a.attnum`;

const CONSTRAINTS_SQL = `
  SELECT
      (SELECT COUNT(*) FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.conname = 'BusinessBookmark_pkey'
          AND cl.relname = 'BusinessBookmark' AND n.nspname = current_schema()) AS has_pkey,
      (SELECT COUNT(*) FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.conname = 'BusinessBookmark_businessProfileId_fkey'
          AND cl.relname = 'BusinessBookmark' AND n.nspname = current_schema()) AS has_business_fk,
      (SELECT COUNT(*) FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.conname = 'BusinessBookmark_customerId_fkey'
          AND cl.relname = 'BusinessBookmark' AND n.nspname = current_schema()) AS has_customer_fk,
      (SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'BusinessBookmark'
          AND indexname = 'BusinessBookmark_businessProfileId_customerId_key'
          AND indexdef LIKE '%UNIQUE%') AS has_unique_pair,
      (SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'BusinessBookmark'
          AND indexname = 'BusinessBookmark_businessProfileId_idx') AS has_business_idx,
      (SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'BusinessBookmark'
          AND indexname = 'BusinessBookmark_customerId_idx') AS has_customer_idx`;

async function installBusinessBookmarkOverlay(prisma) {
    await prisma.$executeRawUnsafe(CREATE_TABLE_SQL);
    await prisma.$executeRawUnsafe(ADD_FK_BUSINESS_SQL);
    await prisma.$executeRawUnsafe(ADD_FK_CUSTOMER_SQL);
    await prisma.$executeRawUnsafe(ADD_UNIQUE_SQL);
    await prisma.$executeRawUnsafe(ADD_IDX_BUSINESS_SQL);
    await prisma.$executeRawUnsafe(ADD_IDX_CUSTOMER_SQL);

    const columns = await prisma.$queryRawUnsafe(VALIDATE_SQL);
    const expect = [
        { name: 'id', type: 'text', not_null: true },
        { name: 'businessProfileId', type: 'text', not_null: true },
        { name: 'customerId', type: 'int4', not_null: true },
        { name: 'createdAt', type: 'timestamp', not_null: true },
    ];
    const problems = [];
    if (columns.length !== expect.length) {
        problems.push('expected exactly ' + expect.length + ' columns, found ' + columns.length);
    } else {
        expect.forEach((e, i) => {
            if (columns[i].column_name !== e.name || columns[i].type_name !== e.type) {
                problems.push('column ' + i + ' is ' + columns[i].column_name + ':' +
                    columns[i].type_name + ', expected ' + e.name + ':' + e.type);
            }
            if (!columns[i].not_null) problems.push(e.name + ' is nullable');
        });
    }
    const constraints = await prisma.$queryRawUnsafe(CONSTRAINTS_SQL);
    const c = constraints[0] || {};
    if (!c.has_pkey || Number(c.has_pkey) < 1) problems.push('missing primary key');
    if (!c.has_business_fk || Number(c.has_business_fk) < 1) problems.push('missing businessProfile FK');
    if (!c.has_customer_fk || Number(c.has_customer_fk) < 1) problems.push('missing customer FK');
    if (!c.has_unique_pair || Number(c.has_unique_pair) < 1) problems.push('missing unique (businessProfileId, customerId)');
    if (!c.has_business_idx || Number(c.has_business_idx) < 1) problems.push('missing businessProfileId index');
    if (!c.has_customer_idx || Number(c.has_customer_idx) < 1) problems.push('missing customerId index');

    if (problems.length) {
        throw new Error('BusinessBookmark drift: ' + problems.join('; '));
    }
    return { ok: 1, failed: 0 };
}

async function main() {
    const prisma = new PrismaClient();
    try {
        const result = await installBusinessBookmarkOverlay(prisma);
        // eslint-disable-next-line no-console
        console.log('[install-business-bookmark-overlay] ok');
        return result;
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[install-business-bookmark-overlay] FAILED:', err.message);
    process.exit(1);
});

module.exports = { installBusinessBookmarkOverlay };
