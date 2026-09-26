-- CreateTable: CrossBorderSusuConfig
CREATE TABLE "CrossBorderSusuConfig" (
    "id" SERIAL NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "baseCurrency" VARCHAR(8) NOT NULL,
    "memberCountries" JSONB NOT NULL,
    "crossBorderFee" DECIMAL(6,4) NOT NULL DEFAULT 0.005,
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrossBorderSusuConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrossBorderSusuConfig_susuGroupId_key" ON "CrossBorderSusuConfig"("susuGroupId");

-- CreateTable: CrossBorderFxSnapshot
CREATE TABLE "CrossBorderFxSnapshot" (
    "id" SERIAL NOT NULL,
    "susuGroupId" TEXT NOT NULL,
    "cycleId" TEXT,
    "userId" INTEGER NOT NULL,
    "fromCurrency" VARCHAR(8) NOT NULL,
    "toCurrency" VARCHAR(8) NOT NULL,
    "localAmount" DECIMAL(20,8) NOT NULL,
    "baseAmount" DECIMAL(20,8) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "fee" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrossBorderFxSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrossBorderFxSnapshot_susuGroupId_createdAt_idx" ON "CrossBorderFxSnapshot"("susuGroupId", "createdAt" DESC);
CREATE INDEX "CrossBorderFxSnapshot_userId_idx" ON "CrossBorderFxSnapshot"("userId");

-- AddForeignKey
ALTER TABLE "CrossBorderSusuConfig" ADD CONSTRAINT "CrossBorderSusuConfig_susuGroupId_fkey"
    FOREIGN KEY ("susuGroupId") REFERENCES "SusuGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrossBorderSusuConfig" ADD CONSTRAINT "CrossBorderSusuConfig_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CrossBorderFxSnapshot" ADD CONSTRAINT "CrossBorderFxSnapshot_susuGroupId_fkey"
    FOREIGN KEY ("susuGroupId") REFERENCES "CrossBorderSusuConfig"("susuGroupId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrossBorderFxSnapshot" ADD CONSTRAINT "CrossBorderFxSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
