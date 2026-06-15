-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('DRAFT', 'FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT', 'SETTLED', 'DISPUTED', 'ADMIN_REVIEW', 'RELEASED', 'REFUNDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('PENDING', 'ASSIGNED', 'UNDER_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisputeRuling" AS ENUM ('FULL_RELEASE', 'FULL_REFUND', 'SPLIT');

-- CreateEnum
CREATE TYPE "KybStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BusinessCategory" AS ENUM ('FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY', 'REAL_ESTATE', 'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT', 'LOGISTICS', 'FINANCIAL_SERVICES', 'OTHER');

-- AlterEnum
ALTER TYPE "ProfitSource" ADD VALUE 'SMART_ESCROW_FEE';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'BUSINESS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'TICKET_ESCROW_FUND';
ALTER TYPE "TransactionType" ADD VALUE 'TICKET_ESCROW_RELEASE';
ALTER TYPE "TransactionType" ADD VALUE 'TICKET_ESCROW_REFUND';
ALTER TYPE "TransactionType" ADD VALUE 'TICKET_ESCROW_FEE';

-- DropIndex
DROP INDEX "User_phoneHash_idx";

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN     "escrowDraftExpiryHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "escrowFundedExpiryDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "smartEscrowFeePct" DECIMAL(6,4) NOT NULL DEFAULT 0.005;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "businessProfileId" TEXT,
ALTER COLUMN "friendshipId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SmartEscrow" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "payerId" INTEGER NOT NULL,
    "payeeId" INTEGER NOT NULL,
    "amountUsdc" DECIMAL(20,8) NOT NULL,
    "feeUsdc" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "status" "EscrowStatus" NOT NULL DEFAULT 'DRAFT',
    "payerSatisfied" BOOLEAN NOT NULL DEFAULT false,
    "payeeSatisfied" BOOLEAN NOT NULL DEFAULT false,
    "deliveryTerms" VARCHAR(1000),
    "dueDate" TIMESTAMP(3),
    "fundedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "warningSentAt" TIMESTAMP(3),
    "fundTxHash" TEXT,
    "releaseTxHash" TEXT,
    "refundTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmartEscrow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowDispute" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "raisedById" INTEGER NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "evidenceUrls" JSONB,
    "status" "DisputeStatus" NOT NULL DEFAULT 'PENDING',
    "assignedToId" INTEGER,
    "ruling" "DisputeRuling",
    "rulingNotes" VARCHAR(2000),
    "payerPct" DECIMAL(5,2),
    "payeePct" DECIMAL(5,2),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscrowDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "bizId" TEXT NOT NULL,
    "businessName" VARCHAR(100) NOT NULL,
    "category" "BusinessCategory" NOT NULL DEFAULT 'OTHER',
    "description" VARCHAR(500),
    "website" VARCHAR(255),
    "logoUrl" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "kybStatus" "KybStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "phoneNumber" VARCHAR(20),
    "contactEmail" VARCHAR(100),
    "address" VARCHAR(255),
    "country" VARCHAR(2),
    "totalEscrows" INTEGER NOT NULL DEFAULT 0,
    "completedEscrows" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "averageRating" DECIMAL(3,2) NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SmartEscrow_ticketId_key" ON "SmartEscrow"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "SmartEscrow_fundTxHash_key" ON "SmartEscrow"("fundTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "SmartEscrow_releaseTxHash_key" ON "SmartEscrow"("releaseTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "SmartEscrow_refundTxHash_key" ON "SmartEscrow"("refundTxHash");

-- CreateIndex
CREATE INDEX "SmartEscrow_payerId_idx" ON "SmartEscrow"("payerId");

-- CreateIndex
CREATE INDEX "SmartEscrow_payeeId_idx" ON "SmartEscrow"("payeeId");

-- CreateIndex
CREATE INDEX "SmartEscrow_status_idx" ON "SmartEscrow"("status");

-- CreateIndex
CREATE INDEX "SmartEscrow_expiresAt_idx" ON "SmartEscrow"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowDispute_escrowId_key" ON "EscrowDispute"("escrowId");

-- CreateIndex
CREATE INDEX "EscrowDispute_status_idx" ON "EscrowDispute"("status");

-- CreateIndex
CREATE INDEX "EscrowDispute_assignedToId_idx" ON "EscrowDispute"("assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_userId_key" ON "BusinessProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_bizId_key" ON "BusinessProfile"("bizId");

-- CreateIndex
CREATE INDEX "BusinessProfile_bizId_idx" ON "BusinessProfile"("bizId");

-- CreateIndex
CREATE INDEX "BusinessProfile_category_idx" ON "BusinessProfile"("category");

-- CreateIndex
CREATE INDEX "BusinessProfile_kybStatus_idx" ON "BusinessProfile"("kybStatus");

-- CreateIndex
CREATE INDEX "BusinessProfile_isVerified_idx" ON "BusinessProfile"("isVerified");

-- CreateIndex
CREATE INDEX "BusinessProfile_businessName_idx" ON "BusinessProfile"("businessName");

-- CreateIndex
CREATE INDEX "Ticket_businessProfileId_idx" ON "Ticket"("businessProfileId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartEscrow" ADD CONSTRAINT "SmartEscrow_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartEscrow" ADD CONSTRAINT "SmartEscrow_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartEscrow" ADD CONSTRAINT "SmartEscrow_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowDispute" ADD CONSTRAINT "EscrowDispute_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "SmartEscrow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowDispute" ADD CONSTRAINT "EscrowDispute_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowDispute" ADD CONSTRAINT "EscrowDispute_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
