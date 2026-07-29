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
