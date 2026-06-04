-- CreateEnum
CREATE TYPE "ProofOfResidencyStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SusuInviteChannel" AS ENUM ('FRIEND', 'PHONE', 'LINK');

-- CreateEnum
CREATE TYPE "SusuInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AdminWarRoomAlertType" AS ENUM ('ADMIN_DEFAULT', 'MASS_DEFAULT_THRESHOLD', 'ESCROW_DIVERSION', 'VOUCH_SLASH_TX_FAILURE');

-- AlterEnum
ALTER TYPE "VouchStatus" ADD VALUE 'VOIDED';

-- DropForeignKey
ALTER TABLE "GroupChat" DROP CONSTRAINT "GroupChat_createdById_fkey";

-- DropForeignKey
ALTER TABLE "SmartRouteRun" DROP CONSTRAINT "SmartRouteRun_userId_fkey";

-- DropForeignKey
ALTER TABLE "SusuContribution" DROP CONSTRAINT "SusuContribution_userId_fkey";

-- DropForeignKey
ALTER TABLE "SusuCycle" DROP CONSTRAINT "SusuCycle_payoutUserId_fkey";

-- DropIndex
DROP INDEX "Ad_tradeAccountId_idx";

-- DropIndex
DROP INDEX "AdminFeeProfile_targetScope_targetValue_idx";

-- AlterTable
ALTER TABLE "AdminFeeProfile" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "platformFeePct" SET DATA TYPE DECIMAL(10,4),
ALTER COLUMN "adminSplitPct" SET DATA TYPE DECIMAL(10,4),
ALTER COLUMN "vendorSplitPct" SET DATA TYPE DECIMAL(10,4),
ALTER COLUMN "exitFeePct" SET DATA TYPE DECIMAL(10,4),
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AzmRewardLog" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AzmSpendLog" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DisputeResolution" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN     "baseExitFeePct" DECIMAL(10,4) NOT NULL DEFAULT 0.02,
ADD COLUMN     "cryptoPlatformFeePct" DECIMAL(10,4) NOT NULL DEFAULT 0.00,
ADD COLUMN     "cryptoWithdrawalFeePct" DECIMAL(10,4) NOT NULL DEFAULT 0.01,
ADD COLUMN     "feeByPaymentMethod" JSONB NOT NULL DEFAULT '{"ZELLE":0.02,"CASHAPP":0.02,"APPLE_PAY":0.025,"GOOGLE_PAY":0.025,"VENMO":0.025,"PAYPAL":0.04,"WISE":0.02,"REVOLUT":0.025,"WESTERN_UNION":0.015,"WIRE_TRANSFER":0.015}',
ADD COLUMN     "fiatWithdrawalFeePct" DECIMAL(10,4) NOT NULL DEFAULT 0.02,
ADD COLUMN     "supportedPaymentMethods" JSONB NOT NULL DEFAULT '[{"key":"ZELLE","label":"Zelle","riskLevel":"LOW","requiredFields":[{"name":"email","label":"Zelle Email","type":"email","placeholder":"you@email.com"},{"name":"phone","label":"Phone (optional)","type":"phone","placeholder":"+1234567890"}]},{"key":"CASHAPP","label":"CashApp","riskLevel":"LOW","requiredFields":[{"name":"cashtag","label":"$Cashtag","type":"text","placeholder":"$YourTag"}]},{"key":"APPLE_PAY","label":"Apple Pay","riskLevel":"MEDIUM","requiredFields":[{"name":"phone","label":"Phone Number","type":"phone","placeholder":"+1234567890"}]},{"key":"GOOGLE_PAY","label":"Google Pay","riskLevel":"MEDIUM","requiredFields":[{"name":"email","label":"Google Pay Email","type":"email","placeholder":"you@gmail.com"}]},{"key":"VENMO","label":"Venmo","riskLevel":"MEDIUM","requiredFields":[{"name":"username","label":"Venmo Username","type":"text","placeholder":"@YourVenmo"}]},{"key":"PAYPAL","label":"PayPal","riskLevel":"HIGH","requiredFields":[{"name":"email","label":"PayPal Email","type":"email","placeholder":"you@email.com"}]},{"key":"WISE","label":"Wise","riskLevel":"LOW","requiredFields":[{"name":"email","label":"Wise Email","type":"email","placeholder":"you@email.com"},{"name":"accountTag","label":"Account Tag","type":"text","placeholder":"@yourtag"}]},{"key":"REVOLUT","label":"Revolut","riskLevel":"MEDIUM","requiredFields":[{"name":"username","label":"Revolut Tag","type":"text","placeholder":"@yourtag"},{"name":"phone","label":"Phone","type":"phone","placeholder":"+1234567890"}]},{"key":"WESTERN_UNION","label":"Western Union","riskLevel":"LOW","requiredFields":[{"name":"fullName","label":"Receiver Full Name","type":"text","placeholder":"John Doe"},{"name":"country","label":"Country","type":"text","placeholder":"US"}]},{"key":"WIRE_TRANSFER","label":"Wire Transfer","riskLevel":"LOW","requiredFields":[{"name":"bankName","label":"Bank Name","type":"text","placeholder":"Chase Bank"},{"name":"accountNumber","label":"Account Number","type":"text","placeholder":"1234567890"},{"name":"routingNumber","label":"Routing Number","type":"text","placeholder":"021000021"}]}]',
ADD COLUMN     "tierThreshold" DECIMAL(20,8) NOT NULL DEFAULT 1000.0,
ADD COLUMN     "vendorMinCollateral" DECIMAL(20,8) NOT NULL DEFAULT 500.0,
ADD COLUMN     "withdrawalFeeByRiskTier" JSONB NOT NULL DEFAULT '{"STANDARD":0.02,"TRUSTED":0.005,"HIGH_RISK":0.05}',
ALTER COLUMN "bankMargin" SET DEFAULT 0.03,
ALTER COLUMN "thirdPartyMargin" SET DEFAULT 0.02;

-- AlterTable
ALTER TABLE "RateAlert" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SavingsDeposit" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SavingsGoal" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SusuCycle" ADD COLUMN     "escrowDivertedAt" TIMESTAMP(3),
ADD COLUMN     "startedCollectingAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SusuGroup" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "contractHash" TEXT,
ADD COLUMN     "contractVersion" TEXT,
ADD COLUMN     "frozenAt" TIMESTAMP(3),
ADD COLUMN     "frozenReason" TEXT;

-- AlterTable
ALTER TABLE "TicketMessage" ALTER COLUMN "type" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "proofOfResidencyRejectionReason" TEXT,
ADD COLUMN     "proofOfResidencyStatus" "ProofOfResidencyStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "proofOfResidencySubmittedAt" TIMESTAMP(3),
ADD COLUMN     "proofOfResidencyUrl" TEXT,
ADD COLUMN     "proofOfResidencyVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "trustRating" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "withdrawalRiskTier" TEXT NOT NULL DEFAULT 'STANDARD';

-- CreateTable
CREATE TABLE "AdminSettingsAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" INTEGER NOT NULL,
    "adminName" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSettingsAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SusuInvite" (
    "id" TEXT NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "inviterId" INTEGER NOT NULL,
    "inviteeUserId" INTEGER,
    "inviteePhone" TEXT,
    "channel" "SusuInviteChannel" NOT NULL,
    "token" TEXT,
    "status" "SusuInviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SusuInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityContractVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contractHash" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" INTEGER NOT NULL,

    CONSTRAINT "LiabilityContractVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityAcceptance" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "contractHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,

    CONSTRAINT "LiabilityAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherSlashLog" (
    "id" TEXT NOT NULL,
    "voucherId" INTEGER,
    "vouchedUserId" INTEGER NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "azmDeducted" DECIMAL(20,8) NOT NULL,
    "trustRatingBefore" INTEGER NOT NULL,
    "trustRatingAfter" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherSlashLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SusuReminderSent" (
    "id" TEXT NOT NULL,
    "susuMemberId" TEXT NOT NULL,
    "susuCycleId" TEXT NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "reminderType" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SusuReminderSent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminWarRoomAlert" (
    "id" TEXT NOT NULL,
    "alertType" "AdminWarRoomAlertType" NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "cycleId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" INTEGER,

    CONSTRAINT "AdminWarRoomAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminSettingsAuditLog_adminId_idx" ON "AdminSettingsAuditLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminSettingsAuditLog_createdAt_idx" ON "AdminSettingsAuditLog"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SusuInvite_token_key" ON "SusuInvite"("token");

-- CreateIndex
CREATE INDEX "SusuInvite_susuGroupId_status_idx" ON "SusuInvite"("susuGroupId", "status");

-- CreateIndex
CREATE INDEX "SusuInvite_inviteeUserId_status_idx" ON "SusuInvite"("inviteeUserId", "status");

-- CreateIndex
CREATE INDEX "SusuInvite_inviteePhone_status_idx" ON "SusuInvite"("inviteePhone", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LiabilityContractVersion_version_key" ON "LiabilityContractVersion"("version");

-- CreateIndex
CREATE UNIQUE INDEX "LiabilityContractVersion_contractHash_key" ON "LiabilityContractVersion"("contractHash");

-- CreateIndex
CREATE INDEX "LiabilityContractVersion_publishedAt_idx" ON "LiabilityContractVersion"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "LiabilityAcceptance_susuGroupId_idx" ON "LiabilityAcceptance"("susuGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "LiabilityAcceptance_userId_susuGroupId_contractVersion_key" ON "LiabilityAcceptance"("userId", "susuGroupId", "contractVersion");

-- CreateIndex
CREATE INDEX "VoucherSlashLog_voucherId_idx" ON "VoucherSlashLog"("voucherId");

-- CreateIndex
CREATE INDEX "VoucherSlashLog_susuGroupId_cycleId_idx" ON "VoucherSlashLog"("susuGroupId", "cycleId");

-- CreateIndex
CREATE INDEX "SusuReminderSent_susuCycleId_idx" ON "SusuReminderSent"("susuCycleId");

-- CreateIndex
CREATE UNIQUE INDEX "SusuReminderSent_susuMemberId_susuCycleId_reminderType_key" ON "SusuReminderSent"("susuMemberId", "susuCycleId", "reminderType");

-- CreateIndex
CREATE INDEX "AdminWarRoomAlert_acknowledgedAt_createdAt_idx" ON "AdminWarRoomAlert"("acknowledgedAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminWarRoomAlert_susuGroupId_idx" ON "AdminWarRoomAlert"("susuGroupId");

-- AddForeignKey
ALTER TABLE "GroupChat" ADD CONSTRAINT "GroupChat_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuCycle" ADD CONSTRAINT "SusuCycle_payoutUserId_fkey" FOREIGN KEY ("payoutUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuContribution" ADD CONSTRAINT "SusuContribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuInvite" ADD CONSTRAINT "SusuInvite_susuGroupId_fkey" FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuInvite" ADD CONSTRAINT "SusuInvite_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuInvite" ADD CONSTRAINT "SusuInvite_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityContractVersion" ADD CONSTRAINT "LiabilityContractVersion_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityAcceptance" ADD CONSTRAINT "LiabilityAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityAcceptance" ADD CONSTRAINT "LiabilityAcceptance_susuGroupId_fkey" FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherSlashLog" ADD CONSTRAINT "VoucherSlashLog_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherSlashLog" ADD CONSTRAINT "VoucherSlashLog_vouchedUserId_fkey" FOREIGN KEY ("vouchedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherSlashLog" ADD CONSTRAINT "VoucherSlashLog_susuGroupId_fkey" FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherSlashLog" ADD CONSTRAINT "VoucherSlashLog_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "SusuCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuReminderSent" ADD CONSTRAINT "SusuReminderSent_susuMemberId_fkey" FOREIGN KEY ("susuMemberId") REFERENCES "SusuMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuReminderSent" ADD CONSTRAINT "SusuReminderSent_susuCycleId_fkey" FOREIGN KEY ("susuCycleId") REFERENCES "SusuCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SusuReminderSent" ADD CONSTRAINT "SusuReminderSent_susuGroupId_fkey" FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminWarRoomAlert" ADD CONSTRAINT "AdminWarRoomAlert_susuGroupId_fkey" FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminWarRoomAlert" ADD CONSTRAINT "AdminWarRoomAlert_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "SusuCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminWarRoomAlert" ADD CONSTRAINT "AdminWarRoomAlert_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartRouteRun" ADD CONSTRAINT "SmartRouteRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "DisputeResolution_adminId" RENAME TO "DisputeResolution_adminId_idx";

-- RenameIndex
ALTER INDEX "DisputeResolution_createdAt" RENAME TO "DisputeResolution_createdAt_idx";

-- RenameIndex
ALTER INDEX "DisputeResolution_status" RENAME TO "DisputeResolution_status_idx";

-- RenameIndex
ALTER INDEX "DisputeResolution_tradeId_unique" RENAME TO "DisputeResolution_tradeId_key";

-- RenameIndex
ALTER INDEX "RateAlert_active_alerts" RENAME TO "RateAlert_isActive_isTriggered_direction_targetRate_idx";

-- RenameIndex
ALTER INDEX "RateAlert_userId_createdAt" RENAME TO "RateAlert_userId_createdAt_idx";
