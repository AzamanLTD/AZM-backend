-- Add new enum value to TransactionType
ALTER TYPE "TransactionType" ADD VALUE 'AZM_CONVERSION_TO_USDC';

-- CreateTable: AzmConversionLog
CREATE TABLE "AzmConversionLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "azmAmount" DECIMAL(20,8) NOT NULL,
    "usdcAmount" DECIMAL(20,8) NOT NULL,
    "rate" DECIMAL(10,6) NOT NULL,
    "baseRate" DECIMAL(10,6) NOT NULL,
    "holderBonus" BOOLEAN NOT NULL DEFAULT false,
    "newAzmBalance" DECIMAL(20,8) NOT NULL,
    "newUsdcBalance" DECIMAL(20,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AzmConversionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AzmConversionLog_userId_createdAt_idx" ON "AzmConversionLog"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AzmConversionLog" ADD CONSTRAINT "AzmConversionLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
