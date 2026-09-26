-- =============================================================================
-- MASTER SPRINT (2026-05-27): VAULT, SUSU, SMART ROUTE, AZM AUCTION
-- =============================================================================

-- ── EXTEND EXISTING ENUMS ───────────────────────────────────────────────────
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'VAULT';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'SUSU';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'SMART_ROUTE';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'AUCTION';

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'VAULT_DEPOSIT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'VAULT_RELEASE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SUSU_CONTRIBUTION';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SUSU_PAYOUT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SUSU_SEIZURE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SMART_ROUTE_RUN';

-- ── NEW ENUMS ───────────────────────────────────────────────────────────────
CREATE TYPE "VaultStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'BROKEN_EARLY', 'CANCELLED');
CREATE TYPE "VaultFrequency" AS ENUM ('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY');
CREATE TYPE "VaultDepositType" AS ENUM ('MANUAL', 'AUTO_RULE', 'BONUS');
CREATE TYPE "VaultDepositStatus" AS ENUM ('COMPLETED', 'FAILED_INSUFFICIENT', 'FAILED_OTHER', 'PENDING');

CREATE TYPE "GroupRole" AS ENUM ('ADMIN', 'MEMBER');
CREATE TYPE "GroupChatStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "SusuStatus" AS ENUM ('CONFIGURING', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'FROZEN_DISPUTE');
CREATE TYPE "SusuFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');
CREATE TYPE "SusuCycleStatus" AS ENUM ('PENDING', 'COLLECTING', 'PAID_OUT', 'DEFAULTED');
CREATE TYPE "SusuMemberStatus" AS ENUM ('PENDING_VOUCH', 'PENDING_CONTRACT', 'ACTIVE', 'DEFAULTED', 'REMOVED');
CREATE TYPE "SusuContributionStatus" AS ENUM ('PAID', 'FAILED_INSUFFICIENT', 'SEIZED');
CREATE TYPE "VouchStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

CREATE TYPE "SmartRouteStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "SmartRouteAction" AS ENUM ('WITHDRAW_MOMO', 'INTERNAL_TRANSFER', 'SAVINGS_DEPOSIT', 'VAULT_DEPOSIT');
CREATE TYPE "SmartRouteFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'ON_DAY_OF_MONTH');
CREATE TYPE "SmartRouteRunStatus" AS ENUM ('SUCCESS', 'FAILED_INSUFFICIENT', 'FAILED_GATEWAY', 'FAILED_OTHER', 'SKIPPED');

CREATE TYPE "AzmAuctionStatus" AS ENUM ('OPEN', 'SETTLING', 'SETTLED', 'CANCELLED');
CREATE TYPE "AzmBidStatus" AS ENUM ('ACTIVE', 'WON', 'LOST', 'REFUNDED');

-- ── PHASE 1: VAULT ──────────────────────────────────────────────────────────
CREATE TABLE "Vault" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "targetAmountUsdc" DECIMAL(20, 8) NOT NULL,
    "currentAmountUsdc" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "status" "VaultStatus" NOT NULL DEFAULT 'ACTIVE',
    "rulesAcceptedAt" TIMESTAMP(3) NOT NULL,
    "rulesAcceptedVersion" INTEGER NOT NULL DEFAULT 1,
    "earlyBreakPenaltyPct" DECIMAL(5, 4) NOT NULL DEFAULT 0.05,
    "isLocked" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "brokenAt" TIMESTAMP(3),
    "autoRuleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRuleAmountUsdc" DECIMAL(20, 8),
    "autoRuleFrequency" "VaultFrequency",
    "autoRuleNextRun" TIMESTAMP(3),
    "streakCount" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "consistencyScore" DECIMAL(5, 2) NOT NULL DEFAULT 0,
    "totalAzmEarned" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "receiptSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vault_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Vault_userId_idx" ON "Vault"("userId");
CREATE INDEX "Vault_status_idx" ON "Vault"("status");
CREATE INDEX "Vault_autoRuleEnabled_autoRuleNextRun_idx" ON "Vault"("autoRuleEnabled", "autoRuleNextRun");
CREATE INDEX "Vault_status_maturityDate_idx" ON "Vault"("status", "maturityDate");
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Balance integrity
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_currentAmountUsdc_check" CHECK ("currentAmountUsdc" >= 0);
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_targetAmountUsdc_check" CHECK ("targetAmountUsdc" > 0);

CREATE TABLE "VaultDeposit" (
    "id" TEXT NOT NULL,
    "vaultId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountUsdc" DECIMAL(20, 8) NOT NULL,
    "type" "VaultDepositType" NOT NULL,
    "status" "VaultDepositStatus" NOT NULL DEFAULT 'COMPLETED',
    "azmAwarded" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "azmBreakdown" JSONB,
    "scheduledFor" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VaultDeposit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VaultDeposit_vaultId_createdAt_idx" ON "VaultDeposit"("vaultId", "createdAt" DESC);
CREATE INDEX "VaultDeposit_userId_createdAt_idx" ON "VaultDeposit"("userId", "createdAt" DESC);
CREATE INDEX "VaultDeposit_status_idx" ON "VaultDeposit"("status");
ALTER TABLE "VaultDeposit" ADD CONSTRAINT "VaultDeposit_vaultId_fkey"
    FOREIGN KEY ("vaultId") REFERENCES "Vault"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultDeposit" ADD CONSTRAINT "VaultDeposit_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PHASE 2: GROUP CHAT ─────────────────────────────────────────────────────
CREATE TABLE "GroupChat" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(280),
    "avatarUrl" TEXT,
    "createdById" INTEGER NOT NULL,
    "status" "GroupChatStatus" NOT NULL DEFAULT 'ACTIVE',
    "susuGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GroupChat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GroupChat_susuGroupId_key" ON "GroupChat"("susuGroupId");
CREATE INDEX "GroupChat_status_idx" ON "GroupChat"("status");
CREATE INDEX "GroupChat_createdById_idx" ON "GroupChat"("createdById");
ALTER TABLE "GroupChat" ADD CONSTRAINT "GroupChat_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedReason" TEXT,
    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GroupMember_groupId_userId_key" ON "GroupMember"("groupId", "userId");
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");
CREATE INDEX "GroupMember_groupId_role_idx" ON "GroupMember"("groupId", "role");
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "GroupChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GroupMessage" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" INTEGER,
    "type" TEXT NOT NULL,
    "content" TEXT,
    "metadata" JSONB,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "mediaMimeType" TEXT,
    "mediaSize" INTEGER,
    "mediaDuration" INTEGER,
    "mediaWaveformPeaks" JSONB,
    "linkPreview" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GroupMessage_groupId_createdAt_idx" ON "GroupMessage"("groupId", "createdAt" DESC);
CREATE INDEX "GroupMessage_senderId_idx" ON "GroupMessage"("senderId");
ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "GroupChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "VouchRecord" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "inviteeId" INTEGER,
    "inviteePhone" TEXT,
    "voucherId" INTEGER NOT NULL,
    "isInviter" BOOLEAN NOT NULL DEFAULT false,
    "relationship" VARCHAR(80) NOT NULL,
    "durationKnown" VARCHAR(40) NOT NULL,
    "reasonForTrust" VARCHAR(500) NOT NULL,
    "acknowledgesPenalty" BOOLEAN NOT NULL DEFAULT false,
    "status" "VouchStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VouchRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VouchRecord_groupId_inviteeId_idx" ON "VouchRecord"("groupId", "inviteeId");
CREATE INDEX "VouchRecord_voucherId_idx" ON "VouchRecord"("voucherId");
CREATE INDEX "VouchRecord_status_idx" ON "VouchRecord"("status");
CREATE INDEX "VouchRecord_inviteePhone_idx" ON "VouchRecord"("inviteePhone");
ALTER TABLE "VouchRecord" ADD CONSTRAINT "VouchRecord_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "GroupChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VouchRecord" ADD CONSTRAINT "VouchRecord_inviteeId_fkey"
    FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VouchRecord" ADD CONSTRAINT "VouchRecord_voucherId_fkey"
    FOREIGN KEY ("voucherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PHASE 2: SUSU ───────────────────────────────────────────────────────────
CREATE TABLE "SusuGroup" (
    "id" TEXT NOT NULL,
    "status" "SusuStatus" NOT NULL DEFAULT 'CONFIGURING',
    "contributionUsdc" DECIMAL(20, 8) NOT NULL,
    "frequency" "SusuFrequency" NOT NULL,
    "totalCycles" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "contractAcceptedCount" INTEGER NOT NULL DEFAULT 0,
    "contractRequiredCount" INTEGER NOT NULL,
    "rotationSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SusuGroup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SusuGroup_status_idx" ON "SusuGroup"("status");
CREATE INDEX "SusuGroup_startDate_idx" ON "SusuGroup"("startDate");

-- Now wire the GroupChat→SusuGroup FK
ALTER TABLE "GroupChat" ADD CONSTRAINT "GroupChat_susuGroupId_fkey"
    FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SusuMember" (
    "id" TEXT NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "cycleSlot" INTEGER NOT NULL,
    "trustScore" DECIMAL(8, 4) NOT NULL,
    "status" "SusuMemberStatus" NOT NULL DEFAULT 'PENDING_CONTRACT',
    "contractAcceptedAt" TIMESTAMP(3),
    "inviterId" INTEGER,
    "vouchedById" INTEGER,
    "defaultedAt" TIMESTAMP(3),
    "totalSeizedUsdc" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    CONSTRAINT "SusuMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SusuMember_susuGroupId_userId_key" ON "SusuMember"("susuGroupId", "userId");
CREATE UNIQUE INDEX "SusuMember_susuGroupId_cycleSlot_key" ON "SusuMember"("susuGroupId", "cycleSlot");
CREATE INDEX "SusuMember_userId_idx" ON "SusuMember"("userId");
CREATE INDEX "SusuMember_status_idx" ON "SusuMember"("status");
ALTER TABLE "SusuMember" ADD CONSTRAINT "SusuMember_susuGroupId_fkey"
    FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SusuMember" ADD CONSTRAINT "SusuMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SusuCycle" (
    "id" TEXT NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "collectionDate" TIMESTAMP(3) NOT NULL,
    "payoutAmount" DECIMAL(20, 8) NOT NULL,
    "payoutUserId" INTEGER NOT NULL,
    "status" "SusuCycleStatus" NOT NULL DEFAULT 'PENDING',
    "paidOutAt" TIMESTAMP(3),
    "defaultsCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SusuCycle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SusuCycle_susuGroupId_cycleNumber_key" ON "SusuCycle"("susuGroupId", "cycleNumber");
CREATE INDEX "SusuCycle_status_collectionDate_idx" ON "SusuCycle"("status", "collectionDate");
CREATE INDEX "SusuCycle_payoutUserId_idx" ON "SusuCycle"("payoutUserId");
ALTER TABLE "SusuCycle" ADD CONSTRAINT "SusuCycle_susuGroupId_fkey"
    FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SusuCycle" ADD CONSTRAINT "SusuCycle_payoutUserId_fkey"
    FOREIGN KEY ("payoutUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "SusuContribution" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amountUsdc" DECIMAL(20, 8) NOT NULL,
    "status" "SusuContributionStatus" NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seizedFromAvailable" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "shortfall" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    CONSTRAINT "SusuContribution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SusuContribution_cycleId_memberId_key" ON "SusuContribution"("cycleId", "memberId");
CREATE INDEX "SusuContribution_userId_idx" ON "SusuContribution"("userId");
CREATE INDEX "SusuContribution_status_idx" ON "SusuContribution"("status");
ALTER TABLE "SusuContribution" ADD CONSTRAINT "SusuContribution_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "SusuCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SusuContribution" ADD CONSTRAINT "SusuContribution_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "SusuMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SusuContribution" ADD CONSTRAINT "SusuContribution_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── PHASE 3: SMART ROUTE ────────────────────────────────────────────────────
CREATE TABLE "SmartRoute" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "action" "SmartRouteAction" NOT NULL,
    "amountUsdc" DECIMAL(20, 8) NOT NULL,
    "frequency" "SmartRouteFrequency" NOT NULL,
    "dayOfMonth" INTEGER,
    "status" "SmartRouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "destMomoNumber" TEXT,
    "destMomoProvider" TEXT,
    "destFriendUserId" INTEGER,
    "destSavingsGoalId" TEXT,
    "destVaultId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "totalRuns" INTEGER NOT NULL DEFAULT 0,
    "totalRoutedUsdc" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SmartRoute_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmartRoute_userId_idx" ON "SmartRoute"("userId");
CREATE INDEX "SmartRoute_status_nextRunAt_idx" ON "SmartRoute"("status", "nextRunAt");
ALTER TABLE "SmartRoute" ADD CONSTRAINT "SmartRoute_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmartRoute" ADD CONSTRAINT "SmartRoute_amount_check" CHECK ("amountUsdc" > 0);

CREATE TABLE "SmartRouteRun" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "SmartRouteRunStatus" NOT NULL,
    "amountUsdc" DECIMAL(20, 8) NOT NULL,
    "amountGhs" DECIMAL(20, 8),
    "rateUsed" DECIMAL(18, 8),
    "withdrawalId" INTEGER,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmartRouteRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmartRouteRun_routeId_createdAt_idx" ON "SmartRouteRun"("routeId", "createdAt" DESC);
CREATE INDEX "SmartRouteRun_userId_createdAt_idx" ON "SmartRouteRun"("userId", "createdAt" DESC);
ALTER TABLE "SmartRouteRun" ADD CONSTRAINT "SmartRouteRun_routeId_fkey"
    FOREIGN KEY ("routeId") REFERENCES "SmartRoute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmartRouteRun" ADD CONSTRAINT "SmartRouteRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── PHASE 4: AZM AUCTION ────────────────────────────────────────────────────
CREATE TABLE "AzmAuction" (
    "id" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "AzmAuctionStatus" NOT NULL DEFAULT 'OPEN',
    "leaderboard" JSONB,
    "winnerCount" INTEGER NOT NULL DEFAULT 3,
    "totalAzmBurned" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AzmAuction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AzmAuction_windowStart_windowEnd_key" ON "AzmAuction"("windowStart", "windowEnd");
CREATE INDEX "AzmAuction_status_idx" ON "AzmAuction"("status");
CREATE INDEX "AzmAuction_windowEnd_idx" ON "AzmAuction"("windowEnd");

CREATE TABLE "AzmAuctionBid" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "adId" INTEGER NOT NULL,
    "bidAmountAzm" DECIMAL(20, 8) NOT NULL,
    "status" "AzmBidStatus" NOT NULL DEFAULT 'ACTIVE',
    "rank" INTEGER,
    "azmBurned" DECIMAL(20, 8) NOT NULL DEFAULT 0,
    "boostedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AzmAuctionBid_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AzmAuctionBid_auctionId_vendorId_key" ON "AzmAuctionBid"("auctionId", "vendorId");
CREATE INDEX "AzmAuctionBid_auctionId_bidAmountAzm_idx" ON "AzmAuctionBid"("auctionId", "bidAmountAzm" DESC);
CREATE INDEX "AzmAuctionBid_vendorId_idx" ON "AzmAuctionBid"("vendorId");
CREATE INDEX "AzmAuctionBid_adId_idx" ON "AzmAuctionBid"("adId");
ALTER TABLE "AzmAuctionBid" ADD CONSTRAINT "AzmAuctionBid_auctionId_fkey"
    FOREIGN KEY ("auctionId") REFERENCES "AzmAuction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AzmAuctionBid" ADD CONSTRAINT "AzmAuctionBid_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AzmAuctionBid" ADD CONSTRAINT "AzmAuctionBid_adId_fkey"
    FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AzmAuctionBid" ADD CONSTRAINT "AzmAuctionBid_bidAmount_check" CHECK ("bidAmountAzm" > 0);
