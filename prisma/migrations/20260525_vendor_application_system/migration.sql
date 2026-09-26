-- Phase V: Vendor Application System
-- Binance-level vendor registration with multi-step KYC

-- CreateEnum
CREATE TYPE "VendorApplicationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "SourceOfFunds" AS ENUM ('EMPLOYMENT', 'BUSINESS', 'INVESTMENTS', 'SAVINGS', 'OTHER');
CREATE TYPE "MonthlyVolumeEstimate" AS ENUM ('TIER_1', 'TIER_2', 'TIER_3', 'TIER_4');

-- CreateTable
CREATE TABLE "VendorApplication" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "VendorApplicationStatus" NOT NULL DEFAULT 'PENDING',

    -- Step 1: Personal Identity
    "legalName" TEXT NOT NULL,
    "dateOfBirth" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "idImageFront" TEXT,
    "idImageBack" TEXT,
    "selfieWithId" TEXT,

    -- Step 2: Proof of Address
    "proofOfAddress" TEXT,
    "addressStreet" TEXT NOT NULL,
    "addressCity" TEXT NOT NULL,
    "addressRegion" TEXT NOT NULL,
    "addressPostal" TEXT,

    -- Step 3: Financial Background
    "sourceOfFunds" "SourceOfFunds" NOT NULL DEFAULT 'EMPLOYMENT',
    "sourceOfFundsOther" TEXT,
    "monthlyVolumeEstimate" "MonthlyVolumeEstimate" NOT NULL DEFAULT 'TIER_1',
    "hasPreviousExperience" BOOLEAN NOT NULL DEFAULT false,
    "previousPlatforms" TEXT,

    -- Step 4: Payment Methods
    "paymentMethods" JSONB NOT NULL DEFAULT '[]',

    -- Step 5: Terms & Collateral
    "acceptedTerms" BOOLEAN NOT NULL DEFAULT false,
    "collateralAmount" DECIMAL(20,8) NOT NULL DEFAULT 500,

    -- Admin Review
    "reviewedBy" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "adminNotes" TEXT,

    -- Timestamps
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes
CREATE INDEX "VendorApplication_userId_idx" ON "VendorApplication"("userId");
CREATE INDEX "VendorApplication_status_idx" ON "VendorApplication"("status");
CREATE INDEX "VendorApplication_createdAt_idx" ON "VendorApplication"("createdAt" DESC);

-- AddForeignKeys
ALTER TABLE "VendorApplication" ADD CONSTRAINT "VendorApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorApplication" ADD CONSTRAINT "VendorApplication_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
