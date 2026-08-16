-- CreateTable
CREATE TABLE "OnchainSweep" (
    "id"          TEXT     NOT NULL,
    "userId"      INTEGER  NOT NULL,
    "fromAddress" TEXT     NOT NULL,
    "toAddress"   TEXT     NOT NULL,
    "amountUsdc"  DECIMAL(20,8) NOT NULL,
    "status"      TEXT     NOT NULL DEFAULT 'BROADCASTING',
    "txHash"      TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "OnchainSweep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnchainSweep_userId_idx" ON "OnchainSweep"("userId");
CREATE INDEX "OnchainSweep_status_idx" ON "OnchainSweep"("status");

-- AddForeignKey
ALTER TABLE "OnchainSweep" ADD CONSTRAINT "OnchainSweep_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
