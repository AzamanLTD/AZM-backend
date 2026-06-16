-- CreateEnum
CREATE TYPE "BusinessOrderStatus" AS ENUM ('AWAITING_PAYMENT', 'PAID', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KybDocumentType" AS ENUM ('BUSINESS_REGISTRATION_CERT', 'DIRECTOR_ID_FRONT', 'DIRECTOR_ID_BACK', 'TAX_IDENTIFICATION', 'PROOF_OF_ADDRESS', 'SELFIE_WITH_ID', 'OTHER');

-- CreateEnum
CREATE TYPE "KybDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "GlobalSettings" ADD COLUMN     "businessOrderDraftExpiryHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "businessOrderFeePct" DECIMAL(6,4) NOT NULL DEFAULT 0.0;

-- CreateTable
CREATE TABLE "BusinessProduct" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(1000),
    "priceUsdc" DECIMAL(20,8) NOT NULL,
    "imageUrls" JSONB,
    "category" "BusinessCategory",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "slug" TEXT NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessOrder" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "customerId" INTEGER NOT NULL,
    "productId" TEXT,
    "escrowId" TEXT,
    "ticketId" TEXT,
    "status" "BusinessOrderStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "orderRef" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "amountUsdc" DECIMAL(20,8) NOT NULL,
    "customerNotes" VARCHAR(500),
    "deliveryNotes" VARCHAR(500),
    "deliveredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessVerificationDocument" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "documentType" "KybDocumentType" NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "status" "KybDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" INTEGER,
    "reviewNotes" VARCHAR(500),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessVerificationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProduct_slug_key" ON "BusinessProduct"("slug");

-- CreateIndex
CREATE INDEX "BusinessProduct_businessProfileId_idx" ON "BusinessProduct"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessProduct_businessProfileId_isActive_idx" ON "BusinessProduct"("businessProfileId", "isActive");

-- CreateIndex
CREATE INDEX "BusinessProduct_slug_idx" ON "BusinessProduct"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessOrder_escrowId_key" ON "BusinessOrder"("escrowId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessOrder_ticketId_key" ON "BusinessOrder"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessOrder_orderRef_key" ON "BusinessOrder"("orderRef");

-- CreateIndex
CREATE INDEX "BusinessOrder_businessProfileId_idx" ON "BusinessOrder"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessOrder_businessProfileId_status_idx" ON "BusinessOrder"("businessProfileId", "status");

-- CreateIndex
CREATE INDEX "BusinessOrder_customerId_idx" ON "BusinessOrder"("customerId");

-- CreateIndex
CREATE INDEX "BusinessOrder_status_idx" ON "BusinessOrder"("status");

-- CreateIndex
CREATE INDEX "BusinessOrder_productId_idx" ON "BusinessOrder"("productId");

-- CreateIndex
CREATE INDEX "BusinessVerificationDocument_businessProfileId_idx" ON "BusinessVerificationDocument"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessVerificationDocument_status_idx" ON "BusinessVerificationDocument"("status");

-- CreateIndex
CREATE INDEX "BusinessVerificationDocument_documentType_idx" ON "BusinessVerificationDocument"("documentType");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessVerificationDocument_businessProfileId_documentType_key" ON "BusinessVerificationDocument"("businessProfileId", "documentType");

-- AddForeignKey
ALTER TABLE "BusinessProduct" ADD CONSTRAINT "BusinessProduct_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOrder" ADD CONSTRAINT "BusinessOrder_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOrder" ADD CONSTRAINT "BusinessOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOrder" ADD CONSTRAINT "BusinessOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BusinessProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOrder" ADD CONSTRAINT "BusinessOrder_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "SmartEscrow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessOrder" ADD CONSTRAINT "BusinessOrder_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessVerificationDocument" ADD CONSTRAINT "BusinessVerificationDocument_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessVerificationDocument" ADD CONSTRAINT "BusinessVerificationDocument_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

