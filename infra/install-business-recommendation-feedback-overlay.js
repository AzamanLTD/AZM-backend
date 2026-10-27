#!/usr/bin/env node
// Idempotent additive installer for the BusinessRecommendationFeedback
// table (marketplace personalisation, Backend D — "Show less like this").
//
// PROVISIONING CONTRACT (DEPLOY_RUNBOOK.md): production DDL is deployed
// EXCLUSIVELY by these overlay installers via `npm run release` AND via
// the boot-time autoRelease.js chain. The table below is the exact shape
// `prisma db push` renders from prisma/schema.prisma, so the db-push path
// (disposable dev/test + CI) and the release-chain/boot-time paths
// (production) converge on the identical structure.
//
// Idempotent: safe to re-run on every deploy/start. FAIL-CLOSED on drift.

const { PrismaClient } = require('@prisma/client');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "BusinessRecommendationFeedback" (
      "id" TEXT NOT NULL,
      "userId" INTEGER NOT NULL,
      "businessProfileId" TEXT NOT NULL,
      "feedbackType" TEXT NOT NULL DEFAULT 'SHOW_LESS',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "BusinessRecommendationFeedback_pkey" PRIMARY KEY ("id")
  )`;

const ADD_FK_USER_SQL = `
  DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'BusinessRecommendationFeedback_userId_fkey') THEN
          ALTER TABLE "BusinessRecommendationFeedback"
              ADD CONSTRAINT "BusinessRecommendationFeedback_userId_fkey"
              FOREIGN KEY ("userId") REFERENCES "User"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
  END $$`;

const ADD_FK_BUSINESS_SQL = `
  DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'BusinessRecommendationFeedback_businessProfileId_fkey') THEN
          ALTER TABLE "BusinessRecommendationFeedback"
              ADD CONSTRAINT "BusinessRecommendationFeedback_businessProfileId_fkey"
              FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id")
              ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
  END $$`;

const ADD_UNIQUE_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS "BusinessRecommendationFeedback_userId_businessProfileId_key"
      ON "BusinessRecommendationFeedback" ("userId", "businessProfileId")`;

const ADD_IDX_BUSINESS_SQL = `
  CREATE INDEX IF NOT EXISTS "BusinessRecommendationFeedback_businessProfileId_idx"
      ON "BusinessRecommendationFeedback" ("businessProfileId")`;

const ADD_IDX_USER_SQL = `
  CREATE INDEX IF NOT EXISTS "BusinessRecommendationFeedback_userId_idx"
      ON "BusinessRecommendationFeedback" ("userId")`;

const VALIDATE_SQL = `
  SELECT a.attname AS column_name, a.attnotnull AS not_null, t.typname AS type_name,
         c.column_default AS column_default
  FROM pg_catalog.pg_class cl
  JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN information_schema.columns c
       ON c.table_schema = n.nspname AND c.table_name = cl.relname AND c.column_name = a.attname
  WHERE n.nspname = current_schema() AND cl.relname = 'BusinessRecommendationFeedback'
  ORDER BY a.attnum`;

const CONSTRAINTS_SQL = `
  SELECT
      (SELECT COUNT(*) FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.conname = 'BusinessRecommendationFeedback_pkey'
          AND cl.relname = 'BusinessRecommendationFeedback' AND n.nspname = current_schema()) AS has_pkey,
      (SELECT COUNT(*) FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.conname = 'BusinessRecommendationFeedback_userId_fkey'
          AND cl.relname = 'BusinessRecommendationFeedback' AND n.nspname = current_schema()) AS has_user_fk,
      (SELECT COUNT(*) FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE con.conname = 'BusinessRecommendationFeedback_businessProfileId_fkey'
          AND cl.relname = 'BusinessRecommendationFeedback' AND n.nspname = current_schema()) AS has_business_fk,
      (SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'BusinessRecommendationFeedback'
          AND indexname = 'BusinessRecommendationFeedback_userId_businessProfileId_key'
          AND indexdef LIKE '%UNIQUE%') AS has_unique_pair,
      (SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'BusinessRecommendationFeedback'
          AND indexname = 'BusinessRecommendationFeedback_businessProfileId_idx') AS has_business_idx`;

async function installBusinessRecommendationFeedbackOverlay(prisma) {
    await prisma.$executeRawUnsafe(CREATE_TABLE_SQL);
    await prisma.$executeRawUnsafe(ADD_FK_USER_SQL);
    await prisma.$executeRawUnsafe(ADD_FK_BUSINESS_SQL);
    await prisma.$executeRawUnsafe(ADD_UNIQUE_SQL);
    await prisma.$executeRawUnsafe(ADD_IDX_BUSINESS_SQL);
    await prisma.$executeRawUnsafe(ADD_IDX_USER_SQL);

    const columns = await prisma.$queryRawUnsafe(VALIDATE_SQL);
    const expect = [
        { name: 'id', type: 'text' },
        { name: 'userId', type: 'int4' },
        { name: 'businessProfileId', type: 'text' },
        { name: 'feedbackType', type: 'text' },
        { name: 'createdAt', type: 'timestamp' },
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
    const c = (await prisma.$queryRawUnsafe(CONSTRAINTS_SQL))[0] || {};
    if (Number(c.has_pkey) < 1) problems.push('missing primary key');
    if (Number(c.has_user_fk) < 1) problems.push('missing user FK');
    if (Number(c.has_business_fk) < 1) problems.push('missing business FK');
    if (Number(c.has_unique_pair) < 1) problems.push('missing unique (userId, businessProfileId)');
    if (Number(c.has_business_idx) < 1) problems.push('missing businessProfileId index');
    if (problems.length) {
        throw new Error('BusinessRecommendationFeedback drift: ' + problems.join('; '));
    }
    return { ok: 1, failed: 0 };
}

async function main() {
    const prisma = new PrismaClient();
    try {
        await installBusinessRecommendationFeedbackOverlay(prisma);
        // eslint-disable-next-line no-console
        console.log('[install-business-recommendation-feedback-overlay] ok');
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[install-business-recommendation-feedback-overlay] FAILED:', err.message);
    process.exit(1);
});

module.exports = { installBusinessRecommendationFeedbackOverlay };
