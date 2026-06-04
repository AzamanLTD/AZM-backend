-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED', 'AUTO_CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('GENERAL', 'SECURITY_ACCOUNT', 'VENDOR_PRIORITY', 'ADMIN_SYSTEM');

-- CreateEnum
CREATE TYPE "BanStatus" AS ENUM ('ACTIVE', 'BANNED_24H', 'BANNED_1W', 'BANNED_INDEF');

-- CreateEnum
CREATE TYPE "AdminVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "LoyaltyTier" AS ENUM ('STANDARD', 'GOLD', 'PLATINUM');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'VENDOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT_FIAT', 'DEPOSIT_CRYPTO', 'WITHDRAWAL_FIAT', 'WITHDRAWAL_CRYPTO', 'P2P_TRADE', 'INTERNAL_TRANSFER');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'FROZEN_DISPUTE');

-- CreateEnum
CREATE TYPE "ProfitSource" AS ENUM ('EXIT_FEE', 'P2P_MARGIN', 'ARBITRAGE_SPREAD');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('TRADE', 'PERSONAL');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'SYSTEM_URGENCY', 'PAYMENT_TRANSFER', 'ADMIN_INTERVENTION', 'IMAGE_PROOF');

-- CreateEnum
CREATE TYPE "ColdStorageDirection" AS ENUM ('TO_COLD', 'TO_HOT');

-- CreateEnum
CREATE TYPE "CorporatePurchaseMethod" AS ENUM ('API', 'MANUAL');

-- CreateEnum
CREATE TYPE "TradeQueueStatus" AS ENUM ('WAITING', 'PROCESSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "availableBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "vendorUnallocatedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "escrowLockedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "disputeEscrowBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "lockedBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "azmBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "ghsBalance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "tatumPolygonAddress" TEXT,
    "influencerCode" TEXT,
    "referredByCode" TEXT,
    "googleId" TEXT,
    "appleId" TEXT,
    "twoFactorSecret" TEXT,
    "isTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pinHash" TEXT,
    "profilePictureUrl" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "fcmToken" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "legalName" TEXT,
    "idType" TEXT,
    "idNumber" TEXT,
    "idImageFront" TEXT,
    "idImageBack" TEXT,
    "tradesCompleted" INTEGER NOT NULL DEFAULT 0,
    "completionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "positiveReviews" INTEGER NOT NULL DEFAULT 0,
    "negativeReviews" INTEGER NOT NULL DEFAULT 0,
    "strikeCount" INTEGER NOT NULL DEFAULT 0,
    "cancellationAbuseCount" INTEGER NOT NULL DEFAULT 0,
    "banStatus" "BanStatus" NOT NULL DEFAULT 'ACTIVE',
    "banUntil" TIMESTAMP(3),
    "loyaltyTier" "LoyaltyTier" NOT NULL DEFAULT 'STANDARD',
    "activeDiscountCredit" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "discountExpiresAt" TIMESTAMP(3),
    "paymentDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "crypto" TEXT NOT NULL DEFAULT 'USDT',
    "pricePerUSD" DOUBLE PRECISION NOT NULL,
    "margin" DOUBLE PRECISION,
    "baseMargin" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "vendorMargin" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "minLimit" DOUBLE PRECISION NOT NULL,
    "maxLimit" DOUBLE PRECISION NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "terms" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "maxPaymentWindow" INTEGER NOT NULL DEFAULT 15,
    "activeHoursStart" TEXT NOT NULL DEFAULT '08:00',
    "activeHoursEnd" TEXT NOT NULL DEFAULT '22:00',
    "maxConcurrentTrades" INTEGER NOT NULL DEFAULT 5,
    "vendorId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" SERIAL NOT NULL,
    "crypto" TEXT NOT NULL,
    "amountCrypto" DOUBLE PRECISION NOT NULL,
    "amountFiat" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "type" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "paymentMethod" TEXT NOT NULL DEFAULT 'Bank Transfer',
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "proofUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "selectedTimeframe" INTEGER NOT NULL DEFAULT 15,
    "tradeStartTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "senderFiatName" TEXT,
    "milestone33Sent" BOOLEAN NOT NULL DEFAULT false,
    "milestone66Sent" BOOLEAN NOT NULL DEFAULT false,
    "milestone99Sent" BOOLEAN NOT NULL DEFAULT false,
    "adminBonusAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "adminBonusMessage" TEXT,
    "vendorProfitCut" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "vendorPaymentDetails" JSONB,
    "userId" INTEGER NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeQueue" (
    "id" TEXT NOT NULL,
    "buyerId" INTEGER NOT NULL,
    "adId" INTEGER NOT NULL,
    "status" "TradeQueueStatus" NOT NULL DEFAULT 'WAITING',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeAccount" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "methodType" TEXT NOT NULL,
    "accountDetails" JSONB NOT NULL,
    "verificationScreenshot" TEXT NOT NULL,
    "adminVerificationStatus" "AdminVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutDestination" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "nickname" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "isExternalCrypto" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL,
    "tradeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" INTEGER,
    "tradeId" INTEGER,
    "messageType" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "savedUserId" INTEGER NOT NULL,
    "nickname" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" SERIAL NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "payoutMethod" TEXT NOT NULL DEFAULT 'BINANCE_ID',
    "network" TEXT,
    "destination" TEXT NOT NULL DEFAULT 'OLD_RECORD',
    "totalGasFee" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "vendorGasShare" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "adminGasShare" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" SERIAL NOT NULL,
    "isPositive" BOOLEAN NOT NULL,
    "comment" TEXT,
    "tradeId" INTEGER NOT NULL,
    "reviewerId" INTEGER NOT NULL,
    "revieweeId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "bankMargin" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "thirdPartyMargin" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "vendorShareUnder1k" DOUBLE PRECISION NOT NULL DEFAULT 0.40,
    "vendorShareOver1k" DOUBLE PRECISION NOT NULL DEFAULT 0.50,
    "gasFeeTrc20" DOUBLE PRECISION NOT NULL DEFAULT 1.00,
    "gasFeeErc20" DOUBLE PRECISION NOT NULL DEFAULT 5.00,
    "gasFeeBep20" DOUBLE PRECISION NOT NULL DEFAULT 0.30,
    "liveUsdToGhs" DOUBLE PRECISION NOT NULL DEFAULT 12.50,
    "liveUsdtToUsd" DOUBLE PRECISION NOT NULL DEFAULT 1.00,
    "liveUsdcToUsd" DOUBLE PRECISION NOT NULL DEFAULT 1.00,
    "liveDaiToUsd" DOUBLE PRECISION NOT NULL DEFAULT 1.00,
    "liveRetailRate" DOUBLE PRECISION NOT NULL DEFAULT 12.50,
    "liveCorporateRate" DOUBLE PRECISION NOT NULL DEFAULT 12.30,
    "liveRateSource" TEXT NOT NULL DEFAULT 'MOCK',
    "lastRateSync" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedWallet" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PENDING',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "accountName" TEXT,
    "secondaryDetail" TEXT,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "actionPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMasterCrypto" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemMasterCrypto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHotWallet" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemHotWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemFiatPool" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemFiatPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemProfitFees" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemProfitFees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionHistory" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amountUsdc" DOUBLE PRECISION NOT NULL,
    "feeUsdc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminProfitLog" (
    "id" TEXT NOT NULL,
    "amountUsdc" DOUBLE PRECISION NOT NULL,
    "source" "ProfitSource" NOT NULL,
    "relatedTxId" TEXT,
    "isSubsidized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminProfitLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "iconUrl" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requiredVolume" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardRecord" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "totalVolume" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "LeaderboardRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountFeedback" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "textReason" TEXT NOT NULL,
    "audioFileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySnapshot" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "totalProfitUsdc" DOUBLE PRECISION NOT NULL,
    "activeUsers" INTEGER NOT NULL,
    "totalVolumeUsdc" DOUBLE PRECISION NOT NULL,
    "profitBySource" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColdStorageLog" (
    "id" SERIAL NOT NULL,
    "amountUsdc" DOUBLE PRECISION NOT NULL,
    "direction" "ColdStorageDirection" NOT NULL,
    "adminId" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColdStorageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorporatePurchaseLog" (
    "id" SERIAL NOT NULL,
    "usdcAmount" DOUBLE PRECISION NOT NULL,
    "fiatSentTotal" DOUBLE PRECISION NOT NULL,
    "discountRate" DOUBLE PRECISION NOT NULL,
    "actualMarketRate" DOUBLE PRECISION NOT NULL,
    "screenshotUrl" TEXT,
    "purchaseMethod" "CorporatePurchaseMethod" NOT NULL,
    "adminId" INTEGER NOT NULL,
    "gatewayProvider" TEXT,
    "gatewayReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorporatePurchaseLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfitWithdrawalLog" (
    "id" SERIAL NOT NULL,
    "amountUsdc" DOUBLE PRECISION NOT NULL,
    "adminId" INTEGER NOT NULL,
    "destination" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfitWithdrawalLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalExpense" (
    "id" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "costUsdc" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ConversationParticipants" (
    "A" TEXT NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ConversationParticipants_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_UserBadges" (
    "A" TEXT NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_UserBadges_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_influencerCode_key" ON "User"("influencerCode");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_appleId_key" ON "User"("appleId");

-- CreateIndex
CREATE INDEX "TradeQueue_buyerId_idx" ON "TradeQueue"("buyerId");

-- CreateIndex
CREATE INDEX "TradeQueue_adId_idx" ON "TradeQueue"("adId");

-- CreateIndex
CREATE INDEX "TradeQueue_status_idx" ON "TradeQueue"("status");

-- CreateIndex
CREATE INDEX "TradeAccount_userId_idx" ON "TradeAccount"("userId");

-- CreateIndex
CREATE INDEX "PayoutDestination_userId_idx" ON "PayoutDestination"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tradeId_key" ON "Conversation"("tradeId");

-- CreateIndex
CREATE INDEX "Conversation_type_idx" ON "Conversation"("type");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- CreateIndex
CREATE INDEX "Message_tradeId_idx" ON "Message"("tradeId");

-- CreateIndex
CREATE INDEX "Contact_userId_idx" ON "Contact"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_userId_savedUserId_key" ON "Contact"("userId", "savedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_tradeId_reviewerId_key" ON "Review"("tradeId", "reviewerId");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionHistory_txHash_key" ON "TransactionHistory"("txHash");

-- CreateIndex
CREATE INDEX "TransactionHistory_userId_idx" ON "TransactionHistory"("userId");

-- CreateIndex
CREATE INDEX "Badge_name_idx" ON "Badge"("name");

-- CreateIndex
CREATE INDEX "LeaderboardRecord_userId_idx" ON "LeaderboardRecord"("userId");

-- CreateIndex
CREATE INDEX "LeaderboardRecord_weekStartDate_idx" ON "LeaderboardRecord"("weekStartDate");

-- CreateIndex
CREATE INDEX "AccountFeedback_userId_idx" ON "AccountFeedback"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DailySnapshot_date_key" ON "DailySnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "CorporatePurchaseLog_gatewayReference_key" ON "CorporatePurchaseLog"("gatewayReference");

-- CreateIndex
CREATE INDEX "OperationalExpense_serviceName_idx" ON "OperationalExpense"("serviceName");

-- CreateIndex
CREATE INDEX "OperationalExpense_timestamp_idx" ON "OperationalExpense"("timestamp");

-- CreateIndex
CREATE INDEX "_ConversationParticipants_B_index" ON "_ConversationParticipants"("B");

-- CreateIndex
CREATE INDEX "_UserBadges_B_index" ON "_UserBadges"("B");

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeQueue" ADD CONSTRAINT "TradeQueue_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeQueue" ADD CONSTRAINT "TradeQueue_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeAccount" ADD CONSTRAINT "TradeAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutDestination" ADD CONSTRAINT "PayoutDestination_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_savedUserId_fkey" FOREIGN KEY ("savedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_revieweeId_fkey" FOREIGN KEY ("revieweeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedWallet" ADD CONSTRAINT "SavedWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionHistory" ADD CONSTRAINT "TransactionHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardRecord" ADD CONSTRAINT "LeaderboardRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountFeedback" ADD CONSTRAINT "AccountFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ConversationParticipants" ADD CONSTRAINT "_ConversationParticipants_A_fkey" FOREIGN KEY ("A") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ConversationParticipants" ADD CONSTRAINT "_ConversationParticipants_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserBadges" ADD CONSTRAINT "_UserBadges_A_fkey" FOREIGN KEY ("A") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserBadges" ADD CONSTRAINT "_UserBadges_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
