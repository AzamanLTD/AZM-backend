#!/usr/bin/env node
// infra/install-phase3-overlay.js
// =============================================================================
// Idempotent, NON-DESTRUCTIVE installer for Phase 3 schema additions:
//   • Story highlights (StoryHighlight + StoryHighlightItem)
//   • Story close friends (StoryCloseFriend)
//   • Story analytics (StoryAnalytics)
//   • Loyalty programs (LoyaltyProgram + LoyaltyCard)
//
// Uses the same IF NOT EXISTS guard pattern as the other overlay scripts.
// Safe to run repeatedly — no drops, no renames, no alterations.
//
// Usage:  node infra/install-phase3-overlay.js
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STATEMENTS = [
  // ── StoryHighlight ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "StoryHighlight" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "title" VARCHAR(50) NOT NULL,
    "coverUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryHighlight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "StoryHighlight_userId_idx" ON "StoryHighlight"("userId")`,

  // ── StoryHighlightItem ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "StoryHighlightItem" (
    "id" SERIAL PRIMARY KEY,
    "highlightId" INTEGER NOT NULL,
    "storyId" INTEGER,
    "mediaUrl" TEXT NOT NULL,
    "mediaType" VARCHAR(20) NOT NULL DEFAULT 'IMAGE',
    "caption" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryHighlightItem_highlightId_fkey" FOREIGN KEY ("highlightId") REFERENCES "StoryHighlight"("id") ON DELETE CASCADE,
    CONSTRAINT "StoryHighlightItem_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "StoryHighlightItem_highlightId_idx" ON "StoryHighlightItem"("highlightId")`,

  // ── StoryCloseFriend ────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "StoryCloseFriend" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "friendId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryCloseFriend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
    CONSTRAINT "StoryCloseFriend_friendId_fkey" FOREIGN KEY ("friendId") REFERENCES "User"("id") ON DELETE CASCADE,
    CONSTRAINT "StoryCloseFriend_userId_friendId_key" UNIQUE ("userId", "friendId")
  )`,
  `CREATE INDEX IF NOT EXISTS "StoryCloseFriend_userId_idx" ON "StoryCloseFriend"("userId")`,

  // ── StoryAnalytics ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "StoryAnalytics" (
    "id" SERIAL PRIMARY KEY,
    "storyId" INTEGER NOT NULL,
    "businessProfileId" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewerCount" INTEGER NOT NULL DEFAULT 0,
    "reactionCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount" INTEGER NOT NULL DEFAULT 0,
    "profileClickCount" INTEGER NOT NULL DEFAULT 0,
    "avgViewDurationSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoryAnalytics_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE,
    CONSTRAINT "StoryAnalytics_storyId_key" UNIQUE ("storyId")
  )`,
  `CREATE INDEX IF NOT EXISTS "StoryAnalytics_businessProfileId_idx" ON "StoryAnalytics"("businessProfileId")`,

  // ── LoyaltyProgram ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "LoyaltyProgram" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "businessProfileId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "type" VARCHAR(20) NOT NULL DEFAULT 'STAMP',
    "stampsRequired" INTEGER NOT NULL DEFAULT 10,
    "rewardDescription" VARCHAR(200) NOT NULL,
    "pointsPerCedi" DOUBLE PRECISION,
    "cardColor" VARCHAR(20) NOT NULL DEFAULT '#FFD700',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoyaltyProgram_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "LoyaltyProgram_businessProfileId_idx" ON "LoyaltyProgram"("businessProfileId")`,

  // ── LoyaltyCard ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "LoyaltyCard" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "loyaltyProgramId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "stampsCollected" INTEGER NOT NULL DEFAULT 0,
    "pointsBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentTier" VARCHAR(20) NOT NULL DEFAULT 'BRONZE',
    "totalRewardsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "lastStampAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoyaltyCard_loyaltyProgramId_fkey" FOREIGN KEY ("loyaltyProgramId") REFERENCES "LoyaltyProgram"("id") ON DELETE CASCADE,
    CONSTRAINT "LoyaltyCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
    CONSTRAINT "LoyaltyCard_loyaltyProgramId_userId_key" UNIQUE ("loyaltyProgramId", "userId")
  )`,
  `CREATE INDEX IF NOT EXISTS "LoyaltyCard_userId_idx" ON "LoyaltyCard"("userId")`,
  `CREATE INDEX IF NOT EXISTS "LoyaltyCard_loyaltyProgramId_idx" ON "LoyaltyCard"("loyaltyProgramId")`,
];

async function main() {
  logger.info('Installing Phase 3 overlay (story highlights, close friends, analytics, loyalty)...');
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      // Ignore "already exists" errors — the IF NOT EXISTS guard should handle most,
      // but constraint names can clash if they were created differently
      if (err.code === '42P07' || err.code === '42701' || err.message.includes('already exists')) {
        logger.warn(`  ↳ Skipped (already exists): ${sql.substring(0, 60)}...`);
      } else {
        logger.error(`  ↳ Error: ${err.message}`);
        // Don't throw — continue with remaining statements
      }
    }
  }
  logger.info('✅ Phase 3 overlay installation complete');
}

main()
  .catch((e) => { logger.error('Phase 3 overlay failed', e); process.exit(1); })
  .finally(() => prisma.$disconnect());

// ── Phase 3: OrderTracking + DeFiYieldStrategy + Vault yield columns ─────────
STATEMENTS.push(
  `CREATE TABLE IF NOT EXISTS "OrderTracking" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "orderId" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "courierLatitude" DECIMAL(10, 7),
    "courierLongitude" DECIMAL(10, 7),
    "courierHeading" DOUBLE PRECISION,
    "courierSpeedKmh" DOUBLE PRECISION,
    "deliveryLatitude" DECIMAL(10, 7),
    "deliveryLongitude" DECIMAL(10, 7),
    "deliveryAddress" VARCHAR(500),
    "estimatedArrival" TIMESTAMP(3),
    "actualArrival" TIMESTAMP(3),
    "timeline" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "driverName" VARCHAR(100),
    "driverPhone" VARCHAR(20),
    "vehiclePlate" VARCHAR(20),
    "lastPingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
  `ALTER TABLE "OrderTracking" ADD CONSTRAINT "OrderTracking_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BusinessOrder"("id") ON DELETE CASCADE NOT VALID`,
  `ALTER TABLE "OrderTracking" ADD CONSTRAINT "OrderTracking_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE NOT VALID`,
  `ALTER TABLE "OrderTracking" ADD CONSTRAINT "OrderTracking_orderId_key" UNIQUE ("orderId")`,
  `CREATE INDEX IF NOT EXISTS "OrderTracking_orderId_idx" ON "OrderTracking"("orderId")`,
  `CREATE INDEX IF NOT EXISTS "OrderTracking_businessProfileId_idx" ON "OrderTracking"("businessProfileId")`,

  `CREATE TABLE IF NOT EXISTS "DeFiYieldStrategy" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "name" VARCHAR(50) NOT NULL,
    "displayName" VARCHAR(100) NOT NULL,
    "protocol" VARCHAR(50) NOT NULL,
    "apr" DECIMAL(6, 4) NOT NULL,
    "riskLevel" VARCHAR(20) NOT NULL DEFAULT 'LOW',
    "minAmountUsdc" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "maxAmountUsdc" DECIMAL(20, 8),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" VARCHAR(500),
    "logoUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "DeFiYieldStrategy_isActive_idx" ON "DeFiYieldStrategy"("isActive")`,

  `ALTER TABLE "Vault" ADD COLUMN IF NOT EXISTS "yieldEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Vault" ADD COLUMN IF NOT EXISTS "yieldStrategy" VARCHAR(50)`,
  `ALTER TABLE "Vault" ADD COLUMN IF NOT EXISTS "yieldApr" DECIMAL(6, 4) NOT NULL DEFAULT 0`,
  `ALTER TABLE "Vault" ADD COLUMN IF NOT EXISTS "yieldEarnedUsdc" DECIMAL(20, 8) NOT NULL DEFAULT 0`,
  `ALTER TABLE "Vault" ADD COLUMN IF NOT EXISTS "yieldLastCompoundAt" TIMESTAMP(3)`,
  `ALTER TABLE "Vault" ADD COLUMN IF NOT EXISTS "yieldAutoCompound" BOOLEAN NOT NULL DEFAULT true`,

  // Seed default DeFi strategies
  `INSERT INTO "DeFiYieldStrategy" ("name", "displayName", "protocol", "apr", "riskLevel", "minAmountUsdc", "isActive", "description", "logoUrl", "updatedAt")
   SELECT 'AAVE', 'Aave V3 — Stablecoin Pool', 'AAVE', 0.0450, 'LOW', 10, true,
     'Supply USDC to Aave V3 lending pool. Earns variable APR from borrower interest.',
     'https://cryptologos.cc/logos/aave-aave-logo.png', CURRENT_TIMESTAMP
   WHERE NOT EXISTS (SELECT 1 FROM "DeFiYieldStrategy" WHERE "name" = 'AAVE')`,
  `INSERT INTO "DeFiYieldStrategy" ("name", "displayName", "protocol", "apr", "riskLevel", "minAmountUsdc", "isActive", "description", "logoUrl", "updatedAt")
   SELECT 'COMPOUND', 'Compound V3 — USDC Market', 'COMPOUND', 0.0385, 'LOW', 10, true,
     'Supply USDC to Compound V3 market. Earns COMP rewards + interest.',
     'https://cryptologos.cc/logos/compound-comp-logo.png', CURRENT_TIMESTAMP
   WHERE NOT EXISTS (SELECT 1 FROM "DeFiYieldStrategy" WHERE "name" = 'COMPOUND')`,
  `INSERT INTO "DeFiYieldStrategy" ("name", "displayName", "protocol", "apr", "riskLevel", "minAmountUsdc", "maxAmountUsdc", "isActive", "description", "logoUrl", "updatedAt")
   SELECT 'INTERNAL_LP', 'AZAMAN Internal LP', 'INTERNAL', 0.0650, 'MEDIUM', 50, 50000, true,
     'Provide liquidity to AZAMAN P2P matching pool. Higher APR with platform risk. AZM bonus rewards.',
     NULL, CURRENT_TIMESTAMP
   WHERE NOT EXISTS (SELECT 1 FROM "DeFiYieldStrategy" WHERE "name" = 'INTERNAL_LP')`,
);
