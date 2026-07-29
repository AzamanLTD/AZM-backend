-- Phase 3 Mobile: Story highlights, close friends, analytics + loyalty programs

-- Story Highlights
CREATE TABLE "StoryHighlight" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" VARCHAR(50) NOT NULL,
    "coverUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryHighlight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoryHighlightItem" (
    "id" SERIAL NOT NULL,
    "highlightId" INTEGER NOT NULL,
    "storyId" INTEGER,
    "mediaUrl" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'IMAGE',
    "caption" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryHighlightItem_pkey" PRIMARY KEY ("id")
);

-- Story Close Friends
CREATE TABLE "StoryCloseFriend" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "friendId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryCloseFriend_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoryCloseFriend_userId_friendId_key" UNIQUE ("userId", "friendId")
);

-- Story Analytics
CREATE TABLE "StoryAnalytics" (
    "id" SERIAL NOT NULL,
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
    CONSTRAINT "StoryAnalytics_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoryAnalytics_storyId_key" UNIQUE ("storyId")
);

-- Loyalty Programs
CREATE TABLE "LoyaltyProgram" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'STAMP',
    "stampsRequired" INTEGER NOT NULL DEFAULT 10,
    "rewardDescription" VARCHAR(200) NOT NULL,
    "pointsPerCedi" DOUBLE PRECISION,
    "cardColor" TEXT NOT NULL DEFAULT '#FFD700',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoyaltyProgram_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoyaltyCard" (
    "id" TEXT NOT NULL,
    "loyaltyProgramId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "stampsCollected" INTEGER NOT NULL DEFAULT 0,
    "pointsBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentTier" TEXT NOT NULL DEFAULT 'BRONZE',
    "totalRewardsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "lastStampAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoyaltyCard_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LoyaltyCard_loyaltyProgramId_userId_key" UNIQUE ("loyaltyProgramId", "userId")
);

-- Foreign keys
ALTER TABLE "StoryHighlight" ADD CONSTRAINT "StoryHighlight_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "StoryHighlightItem" ADD CONSTRAINT "StoryHighlightItem_highlightId_fkey"
    FOREIGN KEY ("highlightId") REFERENCES "StoryHighlight"("id") ON DELETE CASCADE;
ALTER TABLE "StoryHighlightItem" ADD CONSTRAINT "StoryHighlightItem_storyId_fkey"
    FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE SET NULL;

ALTER TABLE "StoryCloseFriend" ADD CONSTRAINT "StoryCloseFriend_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "StoryCloseFriend" ADD CONSTRAINT "StoryCloseFriend_friendId_fkey"
    FOREIGN KEY ("friendId") REFERENCES "User"("id") ON DELETE CASCADE;

ALTER TABLE "StoryAnalytics" ADD CONSTRAINT "StoryAnalytics_storyId_fkey"
    FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE;
ALTER TABLE "StoryAnalytics" ADD CONSTRAINT "StoryAnalytics_businessProfileId_fkey"
    FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;

ALTER TABLE "LoyaltyProgram" ADD CONSTRAINT "LoyaltyProgram_businessProfileId_fkey"
    FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE;

ALTER TABLE "LoyaltyCard" ADD CONSTRAINT "LoyaltyCard_loyaltyProgramId_fkey"
    FOREIGN KEY ("loyaltyProgramId") REFERENCES "LoyaltyProgram"("id") ON DELETE CASCADE;
ALTER TABLE "LoyaltyCard" ADD CONSTRAINT "LoyaltyCard_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;

-- Indexes
CREATE INDEX "StoryHighlight_userId_idx" ON "StoryHighlight"("userId");
CREATE INDEX "StoryHighlightItem_highlightId_idx" ON "StoryHighlightItem"("highlightId");
CREATE INDEX "StoryCloseFriend_userId_idx" ON "StoryCloseFriend"("userId");
CREATE INDEX "StoryAnalytics_businessProfileId_idx" ON "StoryAnalytics"("businessProfileId");
CREATE INDEX "LoyaltyProgram_businessProfileId_idx" ON "LoyaltyProgram"("businessProfileId");
CREATE INDEX "LoyaltyCard_userId_idx" ON "LoyaltyCard"("userId");
CREATE INDEX "LoyaltyCard_loyaltyProgramId_idx" ON "LoyaltyCard"("loyaltyProgramId");
