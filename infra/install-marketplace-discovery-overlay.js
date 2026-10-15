#!/usr/bin/env node
// Idempotent additive installer for the Marketplace Mix discovery surface (P1).
// Authority: docs/MARKETPLACE_MIX_REDESIGN_2026-10-10.md §3.3 (indexes), §4
// (taxonomy, D-2 DECIDED) and §9 D-5 (marketplace-visibility capability
// separation); companion GHS pricing contract for the price eligibility gate
// (enforced by services/businessPriceService.js, NOT by this installer).
//
// PROVISIONING CONTRACT (DEPLOY_RUNBOOK.md): production DDL is deployed
// EXCLUSIVELY by these overlay installers via `npm run release`; `prisma
// db push` and `prisma migrate deploy` are NOT production paths. This
// installer provisions, idempotently and additively (no destructive change):
//   1. BusinessProfile."isPubliclyDiscoverable" — the marketplace-visibility
//      capability (§9 D-5). SEPARATE from storefrontDisabled (the custom
//      SDUI storefront kill-switch): neither bypasses nor implies the other.
//      Default TRUE preserves today's public-search semantics — every
//      unsuspended, unpaused business remains publicly discoverable; the
//      flag gives owners/admins an explicit marketplace hide that leaves the
//      custom storefront untouched.
//   2. CatalogSection."taxonomy" — canonical taxonomy id column (D-2),
//      seeded 'UNMAPPED'.
//   3. CatalogSectionTaxonomy — the canonical mapping table (db-push shape,
//      identical to prisma/schema.prisma) + the seed rows for the ten
//      canonical ids, INCLUDING "UNMAPPED" itself (idempotent upserts).
//   4. Section-taxonomy backfill (D-2 mapping rule): deterministic
//      normalized-name match, seeded with the common Ghana food-house names
//      ("Main Course"→MEALS, "Starters"/"Appetizers"→STARTERS,
//      "Drinks"/"Beverages"→DRINKS, "Sides"/"Extras"→SIDES,
//      "Desserts"/"Sweets"→DESSERTS). Only rows still at the seeded default
//      are rewritten — a portal-set canonical value is never clobbered.
//      v1 limitation (honest): a section deliberately reset to UNMAPPED by
//      the portal is re-matched on the next release run if its name matches;
//      distinguishing "deliberate UNMAPPED" from "never mapped" needs an
//      explicit override-null marker and is deferred with the portal UI (P2).
//      Sections still unmatched stay UNMAPPED: their items remain
//      discoverable under the category's general feed, never under a chip.
//   5. Discovery indexes (§3.3): the three composites the cross-business
//      candidate query drives off — without them the Mix feed table-scans
//      business_products/business_profiles as the marketplace grows.
//      Indexes are built with CREATE INDEX CONCURRENTLY — a plain
//      CREATE INDEX takes a WRITE lock and rewrites/holds the table on a
//      live marketplace, so the concurrent build (no write-blocking) is the
//      production-appropriate path. CONCURRENTLY cannot run inside a
//      transaction, so index statements run OUTSIDE any transaction block
//      as single autocommitted statements, and a build that fails midway
//      (leaving an INVALID index) is detected via pg_index.indisvalid,
//      dropped, and rebuilt on the next run — IF NOT EXISTS alone would
//      silently keep an invalid index forever.
//
// Idempotent: safe to re-run on every deploy. CI runs this installer after
// `db push` (probes no-op); the production release chain runs it standalone.
// The installer is exported as installMarketplaceDiscoveryOverlay(prisma) so
// boot-time autoRelease can converge the same surface without a subprocess,
// and runs as a CLI when invoked directly (`node infra/install-...`).
//
// LIVE-SERVICE PROVISIONING PATH (DEPLOY_RUNBOOK.md, read before
// enabling anything): on the Render Free plan the release chain
// (`npm run release`, 18 installers) is configured as the Pre-Deploy
// Command but NEVER EXECUTED. The installer nonetheless reaches the live
// database at every process start: server.js → bootTreasury() →
// infra/autoRelease.js includes this installer mid-chain (after the
// wallet-address overlay) — that boot-time subset is NOT the full
// release chain (it does not run the BusinessPrice installer; see the
// runbook's ordering invariant). Deployment provisions
// the schema automatically; the remaining activation gates (flag off
// during deploy, post-deploy schema verification, live API smoke tests,
// and real business-confirmed BusinessPrice rows before enabling) are
// listed in the "Marketplace Mix discovery surface" runbook section.

const { PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');

const prisma = new PrismaClient();

// Canonical taxonomy rows (§4, D-2). `applicableCategories` uses the wire
// values of BusinessCategory; empty = every category.
const TAXONOMY_ROWS = [
  { id: 'MEALS',        label: 'Main dishes',    description: 'Main-course food items',            applicableCategories: ['FOOD_BEVERAGE'], displayOrder: 10 },
  { id: 'STARTERS',     label: 'Starters',       description: 'Appetizers and small plates',        applicableCategories: ['FOOD_BEVERAGE'], displayOrder: 20 },
  { id: 'SIDES',        label: 'Sides & extras', description: 'Accompaniments and add-on plates',   applicableCategories: ['FOOD_BEVERAGE'], displayOrder: 30 },
  { id: 'DRINKS',       label: 'Drinks',         description: 'Beverages',                           applicableCategories: ['FOOD_BEVERAGE'], displayOrder: 40 },
  { id: 'DESSERTS',     label: 'Desserts',       description: 'Sweets and desserts',                 applicableCategories: ['FOOD_BEVERAGE'], displayOrder: 50 },
  { id: 'ROOMS',        label: 'Rooms',          description: 'Bookable accommodation',              applicableCategories: ['HOSPITALITY'],   displayOrder: 60 },
  { id: 'RIDES',        label: 'Rides',           description: 'Transit trips and seats',            applicableCategories: ['LOGISTICS'],     displayOrder: 70 },
  { id: 'RETAIL_ITEMS', label: 'Retail items',   description: 'Physical retail products',            applicableCategories: ['RETAIL'],       displayOrder: 80 },
  { id: 'SERVICES',     label: 'Services',        description: 'Bookable services',                   applicableCategories: [],               displayOrder: 90 },
  { id: 'UNMAPPED',     label: 'Uncategorized',  description: 'Section not yet mapped to a chip — items stay in the general feed', applicableCategories: [], displayOrder: 999 },
];

// D-2 deterministic normalized-name mapping. Normalization: lowercase,
// trim, collapse internal whitespace. Portal owner overrides are written
// directly to CatalogSection.taxonomy by the portal and are never touched
// here (the backfill only rewrites rows still at the seeded default).
const NAME_TO_TAXONOMY = new Map([
  ['main course', 'MEALS'],
  ['main', 'MEALS'],
  ['mains', 'MEALS'],
  ['main dishes', 'MEALS'],
  ['starters', 'STARTERS'],
  ['appetizers', 'STARTERS'],
  ['drinks', 'DRINKS'],
  ['beverages', 'DRINKS'],
  ['sides', 'SIDES'],
  ['extras', 'SIDES'],
  ['desserts', 'DESSERTS'],
  ['sweets', 'DESSERTS'],
]);

const normalizeName = (name) =>
  String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');

// Transactional DDL — additive, idempotent, safe inside a transaction.
const STATEMENTS = [
  // 1. Marketplace-visibility flag (§9 D-5) — additive column, default true.
  `ALTER TABLE "BusinessProfile"
     ADD COLUMN IF NOT EXISTS "isPubliclyDiscoverable" BOOLEAN NOT NULL DEFAULT true;`,

  // 2. Canonical taxonomy id on the section (D-2) — additive, default UNMAPPED.
  `ALTER TABLE "CatalogSection"
     ADD COLUMN IF NOT EXISTS "taxonomy" TEXT NOT NULL DEFAULT 'UNMAPPED';`,

  // 3. Canonical mapping table — exact prisma/schema.prisma db-push shape.
  `CREATE TABLE IF NOT EXISTS "CatalogSectionTaxonomy" (
    "id" TEXT NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "description" VARCHAR(200),
    "applicableCategories" TEXT[] NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogSectionTaxonomy_pkey" PRIMARY KEY ("id")
  );`,
];

// Discovery indexes (§3.3) — built CONCURRENTLY (no write-blocking lock), so
// they CANNOT run inside a transaction block: each runs as a single
// autocommitted statement, probed first for existence+validity so a failed
// CONCURRENTLY build (invalid index) is dropped and rebuilt, and an already
// valid index is left untouched.
const CONCURRENT_INDEXES = [
  {
    name: 'business_product_discovery',
    table: 'BusinessProduct',
    columns: '("category", "isActive", "isAvailable")',
  },
  {
    name: 'business_product_section_active',
    table: 'BusinessProduct',
    columns: '("catalogSectionId", "isActive")',
  },
  {
    name: 'business_profile_eligible',
    table: 'BusinessProfile',
    columns: '("category", "isSuspended", "isPausedByOwner")',
  },
];

// Probe one index: 'absent' | 'valid' | 'invalid' (a failed CONCURRENTLY
// build leaves an index with indisvalid=false).
async function indexState(prisma, indexName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    indexName
  );
  if (!rows || rows.length === 0) return 'absent';
  return rows[0].valid === true ? 'valid' : 'invalid';
}

async function ensureConcurrentIndex(prisma, def) {
  const state = await indexState(prisma, def.name);
  if (state === 'valid') {
    return 'kept';
  }
  if (state === 'invalid') {
    // A previous concurrent build failed midway. IF NOT EXISTS would skip it
    // forever, silently leaving the feed without the index — drop and rebuild.
    logger.warn(`[marketplace-discovery-overlay] index ${def.name} exists but is INVALID — dropping and rebuilding`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${def.name}";`);
  }
  // CONCURRENTLY cannot run inside a transaction block: this is a single
  // autocommitted statement via $executeRawUnsafe (no explicit transaction,
  // no $transaction wrapper). It does not block writes on the live table.
  await prisma.$executeRawUnsafe(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${def.name}"
       ON "${def.table}" ${def.columns};`
  );
  const after = await indexState(prisma, def.name);
  if (after !== 'valid') {
    throw new Error(`index ${def.name} is ${after} after concurrent build — runbook: inspect pg_index.indisvalid for this name`);
  }
  return state === 'invalid' ? 'rebuilt' : 'created';
}

async function installMarketplaceDiscoveryOverlay(prisma) {
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      logger.error(`[marketplace-discovery-overlay] statement failed: ${error.message}`);
      throw error;
    }
  }

  // 3b. Seed/refresh the canonical taxonomy rows — upsert so label/description
  // metadata can evolve in future releases without orphaning consumed ids.
  // The `id` values are wire values consumed by clients and are stable.
  for (const row of TAXONOMY_ROWS) {
    await prisma.catalogSectionTaxonomy.upsert({
      where: { id: row.id },
      update: {
        label: row.label,
        description: row.description,
        applicableCategories: row.applicableCategories,
        displayOrder: row.displayOrder,
        isActive: true,
      },
      create: { ...row },
    });
  }

  // 4. D-2 backfill: normalized-name match, only on rows still at the seeded
  // default. Verified-active mapping-table vocabulary only (NAME_TO_TAXONOMY
  // targets are all seeded above), so a row is never mapped to a chip the
  // table does not carry.
  const unmapped = await prisma.catalogSection.findMany({
    where: { taxonomy: 'UNMAPPED' },
    select: { id: true, name: true },
  });
  let mapped = 0;
  for (const section of unmapped) {
    const target = NAME_TO_TAXONOMY.get(normalizeName(section.name));
    if (!target) continue;
    await prisma.catalogSection.update({
      where: { id: section.id },
      data: { taxonomy: target },
    });
    mapped += 1;
  }

  // Discovery indexes (§3.3) — concurrent, probe-first (see CONCURRENT_INDEXES).
  let created = 0;
  let rebuilt = 0;
  let kept = 0;
  for (const def of CONCURRENT_INDEXES) {
    const outcome = await ensureConcurrentIndex(prisma, def);
    if (outcome === 'created') created += 1;
    else if (outcome === 'rebuilt') rebuilt += 1;
    else kept += 1;
  }

  logger.info(
    `[marketplace-discovery-overlay] discovery surface installed (idempotent): ` +
    `${TAXONOMY_ROWS.length} taxonomy rows ensured, ${mapped} sections backfilled by name match, ` +
    `indexes: ${created} created, ${rebuilt} rebuilt, ${kept} kept valid`
  );

  return {
    taxonomyRows: TAXONOMY_ROWS.length,
    sectionsBackfilled: mapped,
    indexesCreated: created,
    indexesRebuilt: rebuilt,
    indexesKept: kept,
  };
}

// CLI wrapper — delegates to the same exported installer so the release
// chain, CI and boot autoRelease all converge the IDENTICAL surface.
async function main() {
  return installMarketplaceDiscoveryOverlay(prisma);
}

// CLI entry (release chain / CI): runs standalone with its own Prisma client.
// When required as a module (autoRelease), exports the installer instead.
module.exports = { installMarketplaceDiscoveryOverlay };

if (require.main === module) {
  main()
    .catch((error) => {
      logger.error(`[marketplace-discovery-overlay] failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
