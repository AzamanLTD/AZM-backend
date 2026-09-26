-- CreateEnum
CREATE TYPE "BizNotifType" AS ENUM ('NEW_ORDER', 'ORDER_FUNDED', 'ORDER_SATISFIED', 'ORDER_DISPUTED', 'ORDER_SETTLED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'KYB_STATUS_CHANGED');

-- CreateTable
CREATE TABLE "BusinessNotification" (
    "id" TEXT NOT NULL,
    "businessProfileId" TEXT NOT NULL,
    "type" "BizNotifType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "metadata" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessNotification_businessProfileId_isRead_idx" ON "BusinessNotification"("businessProfileId", "isRead");

-- CreateIndex
CREATE INDEX "BusinessNotification_businessProfileId_createdAt_idx" ON "BusinessNotification"("businessProfileId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "BusinessNotification" ADD CONSTRAINT "BusinessNotification_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
