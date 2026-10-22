#!/usr/bin/env node
// Idempotent additive installer for the BusinessProfile.offeredCategories
// column (Workstream D, PR #366 — declared additional offerings).
//
// PROVISIONING CONTRACT (DEPLOY_RUNBOOK.md): production DDL is deployed
// EXCLUSIVELY by these overlay installers via `npm run release` AND via
// the boot-time autoRelease.js chain (Render Free plan does not run the
// pre-deploy command, so boot-time provisioning is the real production
// path there). The "offeredCategories" COLUMN is therefore added HERE —
// the DDL below is the exact shape `prisma db push` renders from
// prisma/schema.prisma (BusinessCategory[] enum array, NOT NULL,
// empty-array default), so the db-push path (disposable dev/test + CI)
// and the release-chain/boot-time paths (production) converge on the
// identical structure.
//
// DRIFT VALIDATION uses pg_catalog, NOT information_schema.udt_name:
// an enum-ARRAY column's udt_name is the ARRAY type ('_BusinessCategory')
// and the element enum's typname is the case-preserved identifier, so the
// correct proof is: pg_attribute.atttypid -> the ARRAY type whose
// typelem is the 'BusinessCategory' enum type (typtype 'E'), with
// attnotnull set, plus the empty-array default from information_schema.
//
// Idempotent: safe to re-run on every deploy/start. FAIL-CLOSED on drift:
// a wrong type, nullability or default aborts with a clear error instead
// of silently leaving a mismatched column.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

// ADD COLUMN IF NOT EXISTS ... creates the intended shape when the
// column is absent; the validation below proves the resulting shape.
const ADD_COLUMN_SQL = `
  ALTER TABLE "BusinessProfile"
    ADD COLUMN IF NOT EXISTS "offeredCategories"
    "BusinessCategory"[] NOT NULL DEFAULT ARRAY[]::"BusinessCategory"[]`;

// REALITY (found by CI run 39685609232): Prisma 'db push' renders scalar
// LIST columns NULLABLE (it does so for every list field, e.g. amenities,
// cuisineTypes), and 'ADD COLUMN IF NOT EXISTS' no-ops when db push
// already created the column. So NOT NULL cannot be inherited from the
// schema alone — the installer must ENFORCE it. Normalization is safe and
// idempotent: NULL rows are backfilled to the empty array, the default is
// re-asserted, then SET NOT NULL. Type drift stays FATAL (below).
// NOTE: $executeRawUnsafe prepares ONE statement per call — keep the
// three normalization steps as separate statements.
const NULL_BACKFILL_SQL = `
  UPDATE "BusinessProfile"
     SET "offeredCategories" = ARRAY[]::"BusinessCategory"[]
   WHERE "offeredCategories" IS NULL`;
const SET_DEFAULT_SQL = `
  ALTER TABLE "BusinessProfile"
    ALTER COLUMN "offeredCategories"
    SET DEFAULT ARRAY[]::"BusinessCategory"[]`;
const SET_NOT_NULL_SQL = `
  ALTER TABLE "BusinessProfile"
    ALTER COLUMN "offeredCategories" SET NOT NULL`;

// Schema-qualified pg_catalog proof of the intended shape. current_schema()
// keeps the table_schema check honest under non-public search_path setups.
const VALIDATE_SQL = `
  SELECT
      a.attnotnull           AS not_null,
      t.typelem <> 0         AS is_array,
      et.typname             AS element_type,
      et.typtype             AS element_kind,
      c.column_default       AS column_default
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class cl
       ON cl.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n
       ON n.oid = cl.relnamespace
  JOIN pg_catalog.pg_type t
       ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_type et
       ON et.oid = t.typelem
  LEFT JOIN information_schema.columns c
       ON c.table_schema = n.nspname
      AND c.table_name = cl.relname
      AND c.column_name = a.attname
  WHERE n.nspname = current_schema()
    AND cl.relname = 'BusinessProfile'
    AND a.attname = 'offeredCategories'
    AND a.attnum > 0
    AND NOT a.attisdropped`;

// The db-push default render contains an empty-array literal typed as the
// enum array. A missing or nonempty default is genuine drift.
function defaultIsHonestEmptyArray(def) {
    if (def === null || def === undefined) return false;
    return def.includes('ARRAY[]') || def.includes("'{}'");
}

async function installBusinessOfferedCategoriesOverlay(prisma) {
    await prisma.$executeRawUnsafe(ADD_COLUMN_SQL);
    await prisma.$executeRawUnsafe(NULL_BACKFILL_SQL);
    await prisma.$executeRawUnsafe(SET_DEFAULT_SQL);
    await prisma.$executeRawUnsafe(SET_NOT_NULL_SQL);

    const rows = await prisma.$queryRawUnsafe(VALIDATE_SQL);
    if (rows.length !== 1) {
        throw new Error(
            'BusinessProfile.offeredCategories drift: expected exactly one '
            + 'offeredCategories column after overlay, found '
            + rows.length);
    }
    const row = rows[0];
    const problems = [];
    if (!row.is_array) problems.push('column is not an ARRAY type');
    if (row.element_type !== 'BusinessCategory') {
        problems.push(
            'element type is ' + row.element_type + ', expected the '
            + 'BusinessCategory enum');
    }
    if (row.element_kind !== 'e') {
        problems.push('element type is not an enum');
    }
    if (!row.not_null) problems.push('column is nullable');
    if (!defaultIsHonestEmptyArray(row.column_default)) {
        problems.push(
            'default is ' + row.column_default + ', expected an empty '
            + 'BusinessCategory[] array');
    }
    if (problems.length) {
        throw new Error(
            'BusinessProfile.offeredCategories drift: ' + problems.join('; '));
    }
    return { ok: 1, failed: 0 };
}

module.exports = {
    installBusinessOfferedCategoriesOverlay,
    ADD_COLUMN_SQL,
    VALIDATE_SQL,
};

// Standalone entry point (npm run release chain + CI): fail-closed with a
// non-zero exit code. When required by autoRelease.js the exported
// function above is used instead and this block does not run.
if (require.main === module) {
    const prisma = new PrismaClient();
    installBusinessOfferedCategoriesOverlay(prisma)
        .then(() => logger.info(
            '[business-offered-categories-overlay] '
            + 'BusinessProfile.offeredCategories column installed '
            + '(idempotent, drift-guarded)'))
        .catch((error) => {
            // CI runs with NODE_ENV=test which silences the logger — a
            // fail-closed abort must ALWAYS be visible on stderr.
            console.error(
                '[business-offered-categories-overlay] failed: '
                + error.message);
            logger.error(
                '[business-offered-categories-overlay] failed: '
                + error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await prisma.$disconnect();
        });
}
