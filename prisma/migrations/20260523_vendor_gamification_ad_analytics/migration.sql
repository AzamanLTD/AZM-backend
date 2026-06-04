-- =============================================================================
-- V3: Vendor Gamification + Ad Interaction Analytics
-- =============================================================================

-- New enums
CREATE TYPE "VendorLevel" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'DIAMOND', 'LEGEND');
CREATE TYPE "AdInteractionType" AS ENUM ('VIEWED', 'TRADE_INITIATED', 'CLOSED');

-- Add vendor gamification fields to User
ALTER TABLE "User" ADD COLUMN "vendorXp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "vendorLevel" "VendorLevel" NOT NULL DEFAULT 'BRONZE';
ALTER TABLE "User" ADD COLUMN "currentStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "longestStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lastTradeDate" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "totalVolumeUsdc" DOUBLE PRECISION NOT NULL DEFAULT 0.0;
ALTER TABLE "User" ADD COLUMN "totalProfitUsdc" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- Create AdInteraction table
CREATE TABLE "AdInteraction" (
    "id" TEXT NOT NULL,
    "adId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "AdInteractionType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdInteraction_pkey" PRIMARY KEY ("id")
);

-- Create VendorAchievement table
CREATE TABLE "VendorAchievement" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "achievementId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "iconName" TEXT NOT NULL,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'COMMON',
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorAchievement_pkey" PRIMARY KEY ("id")
);

-- Indexes for AdInteraction
CREATE INDEX "AdInteraction_adId_idx" ON "AdInteraction"("adId");
CREATE INDEX "AdInteraction_userId_idx" ON "AdInteraction"("userId");
CREATE INDEX "AdInteraction_type_idx" ON "AdInteraction"("type");
CREATE INDEX "AdInteraction_createdAt_idx" ON "AdInteraction"("createdAt");
CREATE INDEX "AdInteraction_adId_type_idx" ON "AdInteraction"("adId", "type");

-- Indexes for VendorAchievement
CREATE INDEX "VendorAchievement_userId_idx" ON "VendorAchievement"("userId");
CREATE INDEX "VendorAchievement_achievementId_idx" ON "VendorAchievement"("achievementId");
CREATE UNIQUE INDEX "VendorAchievement_userId_achievementId_key" ON "VendorAchievement"("userId", "achievementId");

-- Foreign keys for AdInteraction
ALTER TABLE "AdInteraction" ADD CONSTRAINT "AdInteraction_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdInteraction" ADD CONSTRAINT "AdInteraction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign keys for VendorAchievement
ALTER TABLE "VendorAchievement" ADD CONSTRAINT "VendorAchievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
