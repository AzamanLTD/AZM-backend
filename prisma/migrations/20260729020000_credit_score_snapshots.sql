-- CreateTable: CreditScoreSnapshot
CREATE TABLE "CreditScoreSnapshot" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "rating" VARCHAR(20) NOT NULL,
    "band" VARCHAR(5) NOT NULL,
    "susuComponent" INTEGER NOT NULL,
    "tradeComponent" INTEGER NOT NULL,
    "accountComponent" INTEGER NOT NULL,
    "financialComponent" INTEGER NOT NULL,
    "reputationComponent" INTEGER NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditScoreSnapshot_userId_calculatedAt_key" ON "CreditScoreSnapshot"("userId", "calculatedAt");
CREATE INDEX "CreditScoreSnapshot_userId_idx" ON "CreditScoreSnapshot"("userId");
CREATE INDEX "CreditScoreSnapshot_calculatedAt_idx" ON "CreditScoreSnapshot"("calculatedAt");

-- AddForeignKey
ALTER TABLE "CreditScoreSnapshot" ADD CONSTRAINT "CreditScoreSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
