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
//
// Idempotent: safe to re-run on every deploy. CI runs this installer after
// `db push` (CREATE … IF NOT EXISTS no-ops); the production release chain
// runs it standalone.

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

  // 5. Discovery indexes (§3.3) — online CREATE INDEX, no lock rewrite.
  `CREATE INDEX IF NOT EXISTS "business_product_discovery"
     ON "BusinessProduct" ("category", "isActive", "isAvailable");`,
  `CREATE INDEX IF NOT EXISTS "business_product_section_active"
     ON "BusinessProduct" ("catalogSectionId", "isActive");`,
  `CREATE INDEX IF NOT EXISTS "business_profile_eligible"
     ON "BusinessProfile" ("category", "isSuspended", "isPausedByOwner");`,
];

async function main() {
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

  logger.info(
    `[marketplace-discovery-overlay] discovery surface installed (idempotent): ` +
    `${TAXONOMY_ROWS.length} taxonomy rows ensured, ${mapped} sections backfilled by name match`
  );
}

main()
  .catch((error) => {
    logger.error(`[marketplace-discovery-overlay] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
